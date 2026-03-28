const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================
const BOTRIX_API_BASE = "https://botrix.live/api";
const BOTRIX_BID = "fgMhJa9%2F7J06PwfKOA7Ayg";
const STREAMER_NAME = "YosukeTV";
const ADMIN_SECRET = "YosukeAdmin2024";               // only used to grant admin to the streamer
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-this";

// 🔑 YOUR TWITCH NUMERIC ID – REPLACE WITH YOUR ACTUAL ID
// You can find it by logging in with Twitch and looking at the console output.
const STREAMER_TWITCH_ID = "1466503227";               // <-- CHANGE THIS TO YOUR TWITCH NUMERIC ID

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Database connection
const MONGODB_URI = process.env.MONGODB_URI;
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        await client.connect();
        db = client.db('botrix');
        console.log('✅ Connected to MongoDB');
        
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        if (!collectionNames.includes('bets')) await db.createCollection('bets');
        if (!collectionNames.includes('users')) await db.createCollection('users');
        if (!collectionNames.includes('admins')) await db.createCollection('admins');
        
        console.log('✅ Database ready');
        console.log(`👑 Streamer Twitch ID: ${STREAMER_TWITCH_ID}`);
    } catch (error) {
        console.error('❌ Database connection error:', error);
        throw error;
    }
}

// ============================================================
// HELPER FUNCTIONS – ADMIN CHECK BY TWITCH ID ONLY
// ============================================================
function isUserAdminByTwitchId(twitchId) {
    return twitchId === STREAMER_TWITCH_ID;
}

async function setUserAdmin(username, twitchId) {
    // Only allow the streamer to become admin
    if (twitchId !== STREAMER_TWITCH_ID) return false;
    await db.collection('admins').updateOne(
        { twitchId: STREAMER_TWITCH_ID },
        { $set: { twitchId: STREAMER_TWITCH_ID, username: username?.toLowerCase(), isAdmin: true, grantedAt: new Date() } },
        { upsert: true }
    );
    return true;
}

// ============================================================
// BOTRIX API (unchanged)
// ============================================================
async function getBotRixUserStatsByUsername(viewerName, platform) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${platformValue}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}&_=${Date.now()}`;
        console.log(`🔄 Fetching stats: ${url}`);
        const response = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
            return { success: true, points: userData.points || 0, level: userData.level || 0, watchtime: userData.watchtime || 0, xp: userData.xp || 0, name: userData.name, followage: userData.followage || 0 };
        }
        return { success: true, points: 0, level: 0, watchtime: 0, xp: 0, name: viewerName, followage: 0 };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function spendBotRixPoints(twitchUserId, amount, platform, reason) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(twitchUserId)}&platform=${platformValue}&points=${amount}&bid=${BOTRIX_BID}&_=${Date.now()}`;
        const response = await fetch(url);
        const data = await response.json();
        return { success: data.success === true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(twitchUserId, amount, platform, reason) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(twitchUserId)}&platform=${platformValue}&points=${-amount}&bid=${BOTRIX_BID}&_=${Date.now()}`;
        const response = await fetch(url);
        const data = await response.json();
        return { success: data.success === true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ============================================================
// CUSTOM AUTH ENDPOINTS
// ============================================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
        const existingUser = await db.collection('users').findOne({ username: username.toLowerCase() });
        if (existingUser) return res.status(400).json({ success: false, message: 'Username already taken' });
        if (username.toLowerCase() === 'yosuketv') return res.status(400).json({ success: false, message: 'This username is reserved' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = { username: username.toLowerCase(), displayName: username, email: email || '', password: hashedPassword, createdAt: new Date(), type: 'custom' };
        const result = await db.collection('users').insertOne(newUser);
        const token = jwt.sign({ userId: result.insertedId, username: username.toLowerCase(), type: 'custom' }, JWT_SECRET, { expiresIn: '7d' });
        // Custom accounts are never admin
        res.json({ success: true, token, user: { id: result.insertedId, username: username.toLowerCase(), displayName: username, type: 'custom', isAdmin: false } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
        const user = await db.collection('users').findOne({ username: username.toLowerCase() });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid username or password' });
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ success: false, message: 'Invalid username or password' });
        // Custom accounts are never admin
        const token = jwt.sign({ userId: user._id, username: user.username, type: 'custom' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user._id, username: user.username, displayName: user.displayName || user.username, type: 'custom', isAdmin: false } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/auth/verify', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type === 'custom') {
            const user = await db.collection('users').findOne({ username: decoded.username });
            if (!user) return res.status(401).json({ success: false, message: 'User not found', clearToken: true });
            res.json({ success: true, user: { id: user._id, username: user.username, displayName: user.displayName || user.username, type: 'custom', isAdmin: false } });
        } else if (decoded.type === 'twitch') {
            const isAdmin = isUserAdminByTwitchId(decoded.twitchId);
            res.json({ success: true, user: { id: decoded.twitchId, username: decoded.username, displayName: decoded.displayName, type: 'twitch', twitchId: decoded.twitchId, isAdmin } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid token type', clearToken: true });
        }
    } catch (jwtError) {
        console.log('JWT Error:', jwtError.message);
        res.status(401).json({ success: false, message: 'Session expired. Please login again.', clearToken: true });
    }
});

// Admin secret – only works for the streamer's Twitch account
app.post('/api/auth/admin-verify', async (req, res) => {
    try {
        const { secretCode, username, twitchId, userType } = req.body;
        // Only the streamer's Twitch account can become admin
        if (secretCode === ADMIN_SECRET && userType === 'twitch' && twitchId === STREAMER_TWITCH_ID) {
            await setUserAdmin(username, twitchId);
            console.log(`✅ Admin granted to streamer (${username}, ${twitchId})`);
            return res.json({ success: true, isAdmin: true, message: 'Admin privileges granted!' });
        }
        res.json({ success: false, isAdmin: false, message: 'Invalid admin code or not the streamer' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/auth/check-admin', async (req, res) => {
    try {
        const { username, twitchId } = req.body;
        // Admin only if Twitch ID matches the streamer's ID
        const isAdmin = (twitchId === STREAMER_TWITCH_ID);
        res.json({ success: true, isAdmin });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// BETTING ENDPOINTS (unchanged)
// ============================================================
app.get('/api/user/:viewer', async (req, res) => {
    try {
        const { viewer } = req.params;
        const platform = req.query.platform || 'twitch';
        const result = await getBotRixUserStatsByUsername(viewer, platform);
        res.json({ success: true, points: result.points, stats: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/place-bet', async (req, res) => {
    try {
        const { userId, viewerName, betAmount, twitchId, platform } = req.body;
        const twitchUserId = twitchId || userId;
        const platformValue = platform || 'twitch';
        const existingBet = await db.collection('bets').findOne({ viewerName: viewerName.toLowerCase(), status: 'pending', platform: platformValue });
        if (existingBet) return res.json({ success: false, message: 'You already have a pending bet!' });
        const userStats = await getBotRixUserStatsByUsername(viewerName, platformValue);
        if (!userStats.success) return res.json({ success: false, message: 'Could not verify points' });
        if (userStats.points < betAmount) return res.json({ success: false, message: `Insufficient points! You have ${userStats.points}, need ${betAmount}.` });
        const spendResult = await spendBotRixPoints(twitchUserId, betAmount, platformValue, `Wheel Bet: ${betAmount} points`);
        if (!spendResult.success) return res.json({ success: false, message: 'Failed to deduct points.' });
        const betEntry = { userId, twitchId: twitchUserId, viewerName: viewerName.toLowerCase(), betAmount, platform: platformValue, status: 'pending', createdAt: new Date() };
        const result = await db.collection('bets').insertOne(betEntry);
        const freshStats = await getBotRixUserStatsByUsername(viewerName, platformValue);
        res.json({ success: true, message: `Bet placed! ${betAmount} points deducted.`, newPoints: freshStats.success ? freshStats.points : userStats.points - betAmount, betId: result.insertedId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pending-bets', async (req, res) => {
    try {
        const bets = await db.collection('bets').find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/resolve-all-win', async (req, res) => {
    try {
        const pendingBets = await db.collection('bets').find({ status: 'pending' }).toArray();
        if (pendingBets.length === 0) return res.json({ success: false, message: 'No pending bets.' });
        let results = [], successCount = 0;
        for (const bet of pendingBets) {
            const winAmount = bet.betAmount * 24;
            const addResult = await addBotRixPoints(bet.twitchId, winAmount, bet.platform || 'twitch', `Wheel Bet WIN - ${winAmount} points`);
            if (addResult.success) {
                await db.collection('bets').updateOne({ _id: bet._id }, { $set: { status: 'win', winAmount, resolvedAt: new Date() } });
                successCount++;
                results.push({ viewer: bet.viewerName, platform: bet.platform, status: 'win', amount: winAmount });
            } else {
                results.push({ viewer: bet.viewerName, platform: bet.platform, status: 'failed', error: 'API error' });
            }
        }
        res.json({ success: true, message: `🎉 Processed ${successCount} wins!`, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/resolve-all-loss', async (req, res) => {
    try {
        const result = await db.collection('bets').updateMany({ status: 'pending' }, { $set: { status: 'loss', resolvedAt: new Date() } });
        res.json({ success: true, message: `💀 Processed ${result.modifiedCount} losses.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/bets/:userId', async (req, res) => {
    try {
        const bets = await db.collection('bets').find({ userId: req.params.userId }).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'BotRix API is running!', mongodb: db ? 'connected' : 'disconnected' });
});

// Start server
connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => process.exit(1));
