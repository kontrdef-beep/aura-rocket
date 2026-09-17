/* =====================================================================
   AURA ROCKET — BACKEND (Node.js + Express + Telegram Bot API)
   Anti-cheat, initData validation, Stars invoices, NFT gifts, treasury.
   ===================================================================== */

'use strict';

const express = require('express');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');
const path = require('path');
const app = express();

/* ---------------------------------------------------------------------
   CONFIGURATION (set via env vars in production)
   --------------------------------------------------------------------- */
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN || '123456789:PUT_YOUR_BOT_TOKEN_HERE',
    OWNER_ID: process.env.OWNER_ID || '777777',
    PORT: process.env.PORT || 3000,
    HOUSE_EDGE: 0.05,           // 5%
    MIN_BET: 10,
    MAX_BET: 1_000_000,
    MIN_MULTIPLIER: 1.00,
    MAX_MULTIPLIER: 100.00,
    ADMIN_PASS_1: 'AURA2026',
    ADMIN_IDS: ['777777', '123456789', '5555555'],
    GIFT_MAP: {
        // gift_id в Bot API → внутренний ID каталога
        torch:    '5170145012310081615',
        rocket:   '5170233102089323212',
        rabbit:   '5168043875654172773',
        sword:    '5170587457011420621',
        crystal:  '5170693465828121220',
        car:      '5170843824902767319',
        heart:    '5170993679782697154',
        diamond:  '5171257972044260278',
        trophy:   '5171415265038265802',
        bear:     '5172267559051266161',
        cake:     '5172478640174865212',
        star:     '5172562281132183215'
    }
};

/* ---------------------------------------------------------------------
   IN-MEMORY DATABASE (replace with PostgreSQL in production)
   --------------------------------------------------------------------- */
const DB = {
    users: new Map(),        // userId → { balance, inventory[], banned }
    rounds: new Map(),       // roundId → round data
    treasury: {
        stars: 0,
        nftStars: 0
    }
};

/* ---------------------------------------------------------------------
   MIDDLEWARE
   --------------------------------------------------------------------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

/* ---------------------------------------------------------------------
   TELEGRAM initData VALIDATION (HMAC-SHA256)
   --------------------------------------------------------------------- */
function validateInitData(initData) {
    if (!initData || typeof initData !== 'string') {
        return { valid: false, reason: 'empty' };
    }
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return { valid: false, reason: 'no_hash' };

        params.delete('hash');
        const dataCheckString = [...params.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(CONFIG.BOT_TOKEN)
            .digest();

        const computedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (computedHash !== hash) {
            return { valid: false, reason: 'hash_mismatch' };
        }

        // Extract user
        const userJson = params.get('user');
        const user = userJson ? JSON.parse(userJson) : null;
        return { valid: true, user };
    } catch (e) {
        return { valid: false, reason: 'exception', error: e.message };
    }
}

/* Middleware — verify every API call */
function authMiddleware(req, res, next) {
    const { initData } = req.body || {};
    const check = validateInitData(initData);
    if (!check.valid) {
        return res.status(401).json({ error: 'Invalid initData', reason: check.reason });
    }
    req.tgUser = check.user;
    next();
}

/* ---------------------------------------------------------------------
   USER DB HELPERS
   --------------------------------------------------------------------- */
function getUser(userId) {
    if (!DB.users.has(userId)) {
        DB.users.set(userId, {
            id: userId,
            balance: 1000,
            inventory: [],
            banned: false,
            totalBets: 0,
            totalWins: 0,
            createdAt: Date.now()
        });
    }
    return DB.users.get(userId);
}

/* ---------------------------------------------------------------------
   TELEGRAM BOT API
   --------------------------------------------------------------------- */
async function tgApi(method, payload) {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

/* ---------------------------------------------------------------------
   ENDPOINTS
   --------------------------------------------------------------------- */

/* GET / — serve index.html */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

/* POST /api/user/init — called on app boot */
app.post('/api/user/init', authMiddleware, (req, res) => {
    const u = getUser(req.tgUser.id);
    res.json({
        balance: u.balance,
        inventory: u.inventory,
        banned: u.banned
    });
});

/* POST /api/round/start — player starts a round, backend returns crash point */
app.post('/api/round/start', authMiddleware, (req, res) => {
    const u = getUser(req.tgUser.id);
    if (u.banned) {
        return res.status(403).json({ error: 'banned' });
    }

    const bet = parseInt(req.body.bet, 10) || 0;
    if (bet < CONFIG.MIN_BET || bet > CONFIG.MAX_BET) {
        return res.status(400).json({ error: 'invalid bet' });
    }
    if (bet > u.balance) {
        return res.status(400).json({ error: 'insufficient balance' });
    }

    // Deduct bet
    u.balance -= bet;
    u.totalBets += bet;
    DB.treasury.stars += bet;

    // Generate crash point (server-side, protected)
    const crashPoint = generateCrashPoint();

    // Save round
    const roundId = crypto.randomBytes(12).toString('hex');
    DB.rounds.set(roundId, {
        userId: req.tgUser.id,
        bet,
        crashPoint,
        startedAt: Date.now(),
        status: 'active'
    });

    res.json({
        roundId,
        crashPoint,
        balance: u.balance,
        serverSeed: crypto.randomBytes(16).toString('hex')
    });
});

/* POST /api/round/cashout — player cashed out before crash */
app.post('/api/round/cashout', authMiddleware, (req, res) => {
    const u = getUser(req.tgUser.id);
    const multiplier = parseFloat(req.body.multiplier) || 0;
    const bet = parseInt(req.body.bet, 10) || 0;

    if (multiplier < 1 || multiplier > CONFIG.MAX_MULTIPLIER) {
        return res.status(400).json({ error: 'invalid multiplier' });
    }

    const win = Math.floor(bet * multiplier);
    u.balance += win;
    u.totalWins += win;
    DB.treasury.stars -= win;

    res.json({ success: true, balance: u.balance, win });
});

/* POST /api/round/end — round crashed */
app.post('/api/round/end', authMiddleware, (req, res) => {
    res.json({ success: true });
});

/* POST /api/create-invoice — Telegram Stars invoice */
app.post('/api/create-invoice', authMiddleware, async (req, res) => {
    const { stars, coins } = req.body;
    if (!stars || !coins) {
        return res.status(400).json({ error: 'missing params' });
    }

    const payload = JSON.stringify({
        userId: req.tgUser.id,
        coins,
        stars,
        nonce: crypto.randomBytes(8).toString('hex')
    });

    try {
        const result = await tgApi('createInvoiceLink', {
            title: `${coins.toLocaleString('ru-RU')} игровых монет`,
            description: `Пополнение Aura Rocket на ${coins} монет`,
            payload,
            currency: 'XTR',
            prices: [{ label: 'Игровые монеты', amount: stars }]
        });

        if (result.ok) {
            res.json({ invoiceLink: result.result });
        } else {
            res.status(500).json({ error: 'tg_api_failed', details: result });
        }
    } catch (e) {
        res.status(500).json({ error: 'exception', details: e.message });
    }
});

/* POST /api/ton-deposit */
app.post('/api/ton-deposit', authMiddleware, (req, res) => {
    const { amount, coins } = req.body;
    if (!amount || !coins) return res.status(400).json({ error: 'missing' });

    const u = getUser(req.tgUser.id);
    u.balance += parseInt(coins, 10);
    res.json({ success: true, balance: u.balance });
});

/* POST /api/nft/deposit */
app.post('/api/nft/deposit', authMiddleware, (req, res) => {
    const { giftId } = req.body;
    if (!giftId) return res.status(400).json({ error: 'missing giftId' });

    const u = getUser(req.tgUser.id);
    u.inventory.push(giftId);
    res.json({ success: true, inventory: u.inventory });
});

/* POST /api/inventory/add */
app.post('/api/inventory/add', authMiddleware, (req, res) => {
    const { giftId } = req.body;
    const u = getUser(req.tgUser.id);
    u.inventory.push(giftId);
    res.json({ success: true });
});

/* POST /api/withdraw-gift — send NFT gift to user via Bot API sendGift */
app.post('/api/withdraw-gift', authMiddleware, async (req, res) => {
    const { giftId } = req.body;
    const u = getUser(req.tgUser.id);

    const idx = u.inventory.indexOf(giftId);
    if (idx === -1) {
        return res.status(404).json({ error: 'gift not in inventory' });
    }

    const externalId = CONFIG.GIFT_MAP[giftId];
    if (!externalId) {
        return res.status(400).json({ error: 'unknown gift id' });
    }

    try {
        const result = await tgApi('sendGift', {
            user_id: req.tgUser.id,
            gift_id: externalId,
            pay_for_upgrade: false
        });

        if (result.ok) {
            u.inventory.splice(idx, 1);
            res.json({ success: true, message: 'Gift sent' });
        } else {
            res.status(500).json({ error: 'send_gift_failed', details: result });
        }
    } catch (e) {
        res.status(500).json({ error: 'exception', details: e.message });
    }
});

/* POST /api/admin/withdraw-treasury */
app.post('/api/admin/withdraw-treasury', authMiddleware, async (req, res) => {
    if (req.tgUser.id.toString() !== CONFIG.OWNER_ID.toString()) {
        return res.status(403).json({ error: 'not owner' });
    }

    const { amount, nftStars } = req.body;

    DB.treasury.stars = 0;
    DB.treasury.nftStars = 0;

    res.json({
        success: true,
        message: `Treasury of ${amount} ⭐ + ${nftStars} ⭐ NFT cleared`,
        ownerId: CONFIG.OWNER_ID
    });
});

/* ---------------------------------------------------------------------
   CRASH POINT GENERATOR (with house edge)
   --------------------------------------------------------------------- */
function generateCrashPoint() {
    // 5% chance of instant crash at 1.00
    const r = Math.random();
    if (r < CONFIG.HOUSE_EDGE) return 1.00;

    // Provably fair-ish: exponential distribution
    const e = 1 / (1 - Math.random() * 0.97);
    const point = Math.max(1.01, Math.min(e, CONFIG.MAX_MULTIPLIER));

    // Round to 2 decimals
    return Math.round(point * 100) / 100;
}

/* ---------------------------------------------------------------------
   TELEGRAM WEBHOOK HANDLER
   --------------------------------------------------------------------- */
app.post(`/webhook/${CONFIG.BOT_TOKEN}`, async (req, res) => {
    const update = req.body;
    try {
        // pre_checkout_query — must respond within 10 seconds
        if (update.pre_checkout_query) {
            await tgApi('answerPreCheckoutQuery', {
                pre_checkout_query_id: update.pre_checkout_query.id,
                ok: true
            });
            return res.sendStatus(200);
        }

        // successful_payment — credit the user
        if (update.message && update.message.successful_payment) {
            const sp = update.message.successful_payment;
            const payload = JSON.parse(sp.invoice_payload || '{}');
            const userId = payload.userId;
            const coins = payload.coins;

            if (userId && coins) {
                const u = getUser(userId);
                u.balance += coins;
                console.log(`[PAYMENT] User ${userId} credited ${coins} coins`);
            }
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error', e);
        res.sendStatus(200);
    }
});

/* ---------------------------------------------------------------------
   PERIODIC TASKS
   --------------------------------------------------------------------- */
setInterval(() => {
    // Clean up old rounds (> 5 min)
    const now = Date.now();
    for (const [id, round] of DB.rounds) {
        if (now - round.startedAt > 5 * 60 * 1000) {
            DB.rounds.delete(id);
        }
    }
}, 60 * 1000);

/* ---------------------------------------------------------------------
   START
   --------------------------------------------------------------------- */
app.listen(CONFIG.PORT, () => {
    console.log('🚀 Aura Rocket backend running on port', CONFIG.PORT);
    console.log('🤖 Bot token configured:', CONFIG.BOT_TOKEN ? 'yes' : 'NO — set BOT_TOKEN');
    console.log('👑 Owner ID:', CONFIG.OWNER_ID);
});

module.exports = app;
