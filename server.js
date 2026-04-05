const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// ── FIREBASE ADMIN ─────────────────────────────────────────
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────────────
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';
const SPORTS_API_KEY = process.env.SPORTS_API_KEY;
const SPORTS_BASE = 'https://v3.football.api-sports.io';

// ════════════════════════════════════════════════════════════
// SPORTS API PROXY
// ════════════════════════════════════════════════════════════

app.get('/api/fixtures', async (req, res) => {
  try {
    const { live, date, league, season } = req.query;
    let url = `${SPORTS_BASE}/fixtures?`;
    if (live) url += `live=all&`;
    if (date) url += `date=${date}&`;
    if (league) url += `league=${league}&`;
    if (season) url += `season=${season || 2024}&`;

    const response = await axios.get(url, {
      headers: { 'x-apisports-key': SPORTS_API_KEY }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fixtures/events', async (req, res) => {
  try {
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/events?fixture=${req.query.fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fixtures/statistics', async (req, res) => {
  try {
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/statistics?fixture=${req.query.fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fixtures/lineups', async (req, res) => {
  try {
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/lineups?fixture=${req.query.fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ════════════════════════════════════════════════════════════

// Initialize payment
app.post('/api/payment/initialize', async (req, res) => {
  try {
    const { email, amount, userId, phone } = req.body;

    if (amount < 100) {
      return res.status(400).json({ error: 'Minimum deposit is ₦100' });
    }

    const response = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email,
        amount: amount * 100,
        metadata: { userId, phone },
        callback_url: process.env.FRONTEND_URL
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify payment + auto credit
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { reference, userId } = req.body;

    const response = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const payment = response.data.data;
    if (payment.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const amount = payment.amount / 100;
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const currentBalance = userData.balance || 0;
    const hasDeposited = userData.hasDeposited || false;

    // 30% bonus on first deposit of ₦100+
    let bonus = 0;
    if (!hasDeposited && amount >= 100) {
      bonus = Math.floor(amount * 0.30);
    }

    const newBalance = currentBalance + amount + bonus;

    await userRef.update({
      balance: newBalance,
      hasDeposited: true,
      lastDeposit: amount,
      lastDepositDate: new Date().toISOString(),
      bonusReceived: (userData.bonusReceived || 0) + bonus
    });

    await db.collection('transactions').add({
      userId,
      type: 'deposit',
      amount,
      bonus,
      reference,
      status: 'success',
      date: new Date().toISOString(),
      balanceAfter: newBalance
    });

    res.json({
      success: true,
      amount,
      bonus,
      newBalance,
      message: bonus > 0
        ? `₦${amount} deposited + ₦${bonus} bonus!`
        : `₦${amount} deposited successfully!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Paystack webhook auto credit
app.post('/api/webhook', async (req, res) => {
  try {
    const event = req.body;

    if (event.event === 'charge.success') {
      const payment = event.data;
      const userId = payment.metadata?.userId;
      const amount = payment.amount / 100;

      if (userId) {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
          const userData = userDoc.data();
          const hasDeposited = userData.hasDeposited || false;
          let bonus = 0;
          if (!hasDeposited && amount >= 100) {
            bonus = Math.floor(amount * 0.30);
          }

          await userRef.update({
            balance: (userData.balance || 0) + amount + bonus,
            hasDeposited: true
          });

          await db.collection('transactions').add({
            userId,
            type: 'deposit',
            amount,
            bonus,
            reference: payment.reference,
            status: 'success',
            date: new Date().toISOString()
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// WITHDRAWAL ROUTES
// ════════════════════════════════════════════════════════════

// Get banks list
app.get('/api/banks', async (req, res) => {
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/bank`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify bank account
app.post('/api/verify-account', async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;
    const response = await axios.get(
      `${PAYSTACK_BASE}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process withdrawal
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, bankCode, accountNumber, accountName } = req.body;

    if (amount < 500) {
      return res.status(400).json({ error: 'Minimum withdrawal is ₦500' });
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    if ((userData.balance || 0) < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create transfer recipient
    const recipientRes = await axios.post(
      `${PAYSTACK_BASE}/transferrecipient`,
      {
        type: 'nuban',
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN'
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const recipientCode = recipientRes.data.data.recipient_code;

    // Send transfer
    const transferRes = await axios.post(
      `${PAYSTACK_BASE}/transfer`,
      {
        source: 'balance',
        amount: amount * 100,
        recipient: recipientCode,
        reason: 'BetZone Pro Withdrawal'
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    // Deduct balance
    await userRef.update({
      balance: (userData.balance || 0) - amount
    });

    // Save transaction
    await db.collection('transactions').add({
      userId,
      type: 'withdrawal',
      amount,
      accountNumber,
      accountName,
      bankCode,
      status: 'processing',
      transferCode: transferRes.data.data.transfer_code,
      date: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `₦${amount} sent to ${accountName} successfully!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// BETTING ROUTES
// ════════════════════════════════════════════════════════════

// Place bet
app.post('/api/bet/place', async (req, res) => {
  try {
    const { userId, selections, stake, betType, totalOdds, potentialWin } = req.body;

    if (stake < 50) {
      return res.status(400).json({ error: 'Minimum stake is ₦50' });
    }

    if (potentialWin > 10000000) {
      return res.status(400).json({ error: 'Maximum win is ₦10,000,000' });
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    if (userData.suspended) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    if ((userData.balance || 0) < stake) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await userRef.update({
      balance: (userData.balance || 0) - stake
    });

    const betRef = await db.collection('bets').add({
      userId,
      selections,
      stake,
      betType,
      totalOdds,
      potentialWin,
      status: 'pending',
      date: new Date().toISOString()
    });

    await db.collection('transactions').add({
      userId,
      type: 'bet',
      amount: stake,
      betId: betRef.id,
      status: 'pending',
      date: new Date().toISOString()
    });

    res.json({
      success: true,
      betId: betRef.id,
      message: `Bet placed! Potential win: ₦${potentialWin.toLocaleString()}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user bets
app.get('/api/bet/history/:userId', async (req, res) => {
  try {
    const bets = await db.collection('bets')
      .where('userId', '==', req.params.userId)
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    res.json({
      success: true,
      bets: bets.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user transactions
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const txns = await db.collection('transactions')
      .where('userId', '==', req.params.userId)
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    res.json({
      success: true,
      transactions: txns.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════

// Get all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.collection('users').get();
    res.json({
      success: true,
      users: users.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Credit user by phone
app.post('/api/admin/credit', async (req, res) => {
  try {
    const { phone, amount, reason } = req.body;
    const users = await db.collection('users')
      .where('phone', '==', phone).get();

    if (users.empty) {
      return res.status(404).json({ error: 'User not found with that phone number' });
    }

    const userDoc = users.docs[0];
    const userData = userDoc.data();
    const newBalance = (userData.balance || 0) + amount;

    await userDoc.ref.update({ balance: newBalance });

    await db.collection('transactions').add({
      userId: userDoc.id,
      type: 'admin_credit',
      amount,
      reason: reason || 'Admin credit',
      date: new Date().toISOString(),
      balanceAfter: newBalance
    });

    res.json({
      success: true,
      message: `₦${amount} credited to ${userData.name || phone}`,
      newBalance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suspend user
app.post('/api/admin/suspend', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    await db.collection('users').doc(userId).update({
      suspended: true,
      suspendReason: reason,
      suspendDate: new Date().toISOString()
    });
    res.json({ success: true, message: 'User suspended successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsuspend user
app.post('/api/admin/unsuspend', async (req, res) => {
  try {
    const { userId } = req.body;
    await db.collection('users').doc(userId).update({
      suspended: false,
      suspendReason: null
    });
    res.json({ success: true, message: 'User unsuspended successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all bets
app.get('/api/admin/bets', async (req, res) => {
  try {
    const bets = await db.collection('bets')
      .orderBy('date', 'desc').limit(100).get();
    res.json({
      success: true,
      bets: bets.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settle bet (admin marks win or loss)
app.post('/api/admin/settle-bet', async (req, res) => {
  try {
    const { betId, result } = req.body;
    const betRef = db.collection('bets').doc(betId);
    const betDoc = await betRef.get();

    if (!betDoc.exists) {
      return res.status(404).json({ error: 'Bet not found' });
    }

    const bet = betDoc.data();

    await betRef.update({ status: result });

    if (result === 'won') {
      const userRef = db.collection('users').doc(bet.userId);
      const userDoc = await userRef.get();
      const userData = userDoc.data();

      const winAmount = Math.min(bet.potentialWin, 10000000);
      await userRef.update({
        balance: (userData.balance || 0) + winAmount
      });

      await db.collection('transactions').add({
        userId: bet.userId,
        type: 'win',
        amount: winAmount,
        betId,
        date: new Date().toISOString()
      });
    }

    res.json({ success: true, message: `Bet marked as ${result}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profit/loss report
app.get('/api/admin/report', async (req, res) => {
  try {
    const txns = await db.collection('transactions').get();
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalBets = 0;
    let totalWinnings = 0;
    let totalBonus = 0;

    txns.docs.forEach(doc => {
      const t = doc.data();
      if (t.type === 'deposit') { totalDeposits += t.amount; totalBonus += t.bonus || 0; }
      if (t.type === 'withdrawal') totalWithdrawals += t.amount;
      if (t.type === 'bet') totalBets += t.amount;
      if (t.type === 'win') totalWinnings += t.amount;
    });

    res.json({
      success: true,
      report: {
        totalDeposits,
        totalWithdrawals,
        totalBets,
        totalWinnings,
        totalBonus,
        grossProfit: totalBets - totalWinnings,
        netProfit: totalDeposits - totalWithdrawals - totalWinnings
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send notification
app.post('/api/admin/notify', async (req, res) => {
  try {
    const { title, message } = req.body;
    await db.collection('notifications').add({
      title,
      message,
      date: new Date().toISOString(),
      readBy: []
    });
    res.json({ success: true, message: 'Notification sent!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ BetZone Backend running on port ${PORT}`);
});
