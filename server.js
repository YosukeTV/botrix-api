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

// ADMIN SECRET - Only YOU know this code!
// Change this to your own secret code
const ADMIN_SECRET = "YosukeAdmin2024";

// JWT Secret - Use environment variable in production
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-this-in-production";

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
        
        if (!collectionNames.includes('bets')) {
            await db.createCollection('bets');
            console.log('✅ Created bets collection');
        }
        
        if (!collectionNames.includes('users')) {
            await db.createCollection('users');
            console.log('✅ Created users collection');
        }
        
        if (!collectionNames.includes('admins')) {
            await db.createCollection('admins');
            console.log('✅ Created admins collection');
        }
        
        console.log('✅ Database ready');
        console.log(`🔐 Admin secret configured`);
    } catch (error) {
        console.error('❌ Database connection error:', error);
        throw error;
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Check if user is admin
async function isUserAdmin(username, twitchId = null) {
    const adminRecord = await db.collection('admins').findOne({ 
        $or: [
            { username: username?.toLowerCase() },
            { twitchId: twitchId }
        ]
    });
    return !!adminRecord;
}

// Grant admin privileges to user
async function setUserAdmin(username, twitchId = null) {
    await db.collection('admins').updateOne(
        { 
            $or: [
                { username: username?.toLowerCase() },
                { twitchId: twitchId }
            ]
        },
        { 
            $set: { 
                username: username?.toLowerCase(),
                twitchId: twitchId,
                isAdmin: true,
                grantedAt: new Date()
            }
        },
        { upsert: true }
    );
}

// ============================================================
// BOTRIX PUBLIC API - GET USER STATS
// ============================================================

async function getBotRixUserStatsByUsername(viewerName, platform) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${platformValue}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}&_=${Date.now()}`;
        console.log(`🔄 Fetching fresh stats from: ${url}`);
        
        const response = await fetch(url, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
        });
        const data = await response.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
            console.log(`✅ Found ${viewerName} on ${platformValue}: ${userData.points} points`);
            return { 
                success: true, 
                points: userData.points || 0,
                level: userData.level || 0,
                watchtime: userData.watchtime || 0,
                xp: userData.xp || 0,
                name: userData.name,
                followage: userData.followage || 0,
                platform: platformValue
            };
        }
        console.log(`⚠️ User ${viewerName} not found on ${platformValue}, returning 0 points`);
        return { success: true, points: 0, level: 0, watchtime: 0, xp: 0, name: viewerName, followage: 0, platform: platformValue };
    } catch (error) {
        console.error('Error fetching user stats:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// BOTRIX PRIVATE API - SPEND / ADD POINTS
// ============================================================

async function spendBotRixPoints(twitchUserId, amount, platform, reason) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(twitchUserId)}&platform=${platformValue}&points=${amount}&bid=${BOTRIX_BID}&_=${Date.now()}`;
        console.log(`🔴 Spending ${amount} points for user ID: ${twitchUserId} on ${platformValue}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`🔴 Response:`, data);
        
        return { success: data.success === true };
    } catch (error) {
        console.error('Error spending points:', error);
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(twitchUserId, amount, platform, reason) {
    try {
        const platformValue = platform || 'twitch';
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(twitchUserId)}&platform=${platformValue}&points=${-amount}&bid=${BOTRIX_BID}&_=${Date.now()}`;
        console.log(`🟢 Adding ${amount} points to user ID: ${twitchUserId} on ${platformValue}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`🟢 Response:`, data);
        
        return { success: data.success === true };
    } catch (error) {
        console.error('Error adding points:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// CUSTOM AUTH ENDPOINTS
// ============================================================

// Register a new user (Custom account)
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }
        
        // Check if user already exists in custom users collection
        const existingUser = await db.collection('users').findOne({ username: username.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Username already taken' });
        }
        
        // Prevent users from creating admin username
        if (username.toLowerCase() === 'yosuketv') {
            return res.status(400).json({ success: false, message: 'This username is reserved' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = {
            username: username.toLowerCase(),
            displayName: username,
            email: email || '',
            password: hashedPassword,
            createdAt: new Date(),
            type: 'custom'
        };
        
        const result = await db.collection('users').insertOne(newUser);
        
        // Check if this user is admin (for the streamer's custom account)
        const isAdmin = await isUserAdmin(username.toLowerCase());
        
        const token = jwt.sign(
            { userId: result.insertedId, username: username.toLowerCase(), type: 'custom', isAdmin: isAdmin },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: result.insertedId,
                username: username.toLowerCase(),
                displayName: username,
                type: 'custom',
                isAdmin: isAdmin
            }
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Login with username/password (Custom account)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }
        
        const user = await db.collection('users').findOne({ username: username.toLowerCase() });
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
        
        const isAdmin = await isUserAdmin(user.username);
        
        const token = jwt.sign(
            { userId: user._id, username: user.username, type: 'custom', isAdmin: isAdmin },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                displayName: user.displayName || user.username,
                type: 'custom',
                isAdmin: isAdmin
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify JWT token
app.post('/api/auth/verify', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }
        
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            if (decoded.type === 'custom') {
                const user = await db.collection('users').findOne({ username: decoded.username });
                if (!user) {
                    return res.status(401).json({ success: false, message: 'User not found', clearToken: true });
                }
                
                const isAdmin = await isUserAdmin(user.username);
                
                res.json({
                    success: true,
                    user: {
                        id: user._id,
                        username: user.username,
                        displayName: user.displayName || user.username,
                        type: 'custom',
                        isAdmin: isAdmin
                    }
                });
            } else if (decoded.type === 'twitch') {
                const isAdmin = await isUserAdmin(decoded.username, decoded.twitchId);
                
                res.json({
                    success: true,
                    user: {
                        id: decoded.twitchId,
                        username: decoded.username,
                        displayName: decoded.displayName,
                        type: 'twitch',
                        twitchId: decoded.twitchId,
                        isAdmin: isAdmin
                    }
                });
            } else {
                res.status(401).json({ success: false, message: 'Invalid token type', clearToken: true });
            }
        } catch (jwtError) {
            console.log('JWT Error:', jwtError.message);
            res.status(401).json({ 
                success: false, 
                message: 'Session expired. Please login again.', 
                clearToken: true 
            });
        }
        
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ============================================================
// ADMIN SECRET ENDPOINT
// ============================================================

// Verify admin secret and grant admin privileges
app.post('/api/auth/admin-verify', async (req, res) => {
    try {
        const { secretCode, username, twitchId, userType } = req.body;
        
        console.log(`Admin verification attempt for: ${username} (type: ${userType})`);
        
        if (secretCode === ADMIN_SECRET) {
            // Grant admin privileges to this user
            await setUserAdmin(username, twitchId);
            console.log(`✅ Admin privileges granted to: ${username}`);
            
            return res.json({ 
                success: true, 
                isAdmin: true,
                message: 'Admin privileges granted!'
            });
        }
        
        console.log(`❌ Failed admin attempt for: ${username} - wrong secret`);
        res.json({ success: false, isAdmin: false, message: 'Invalid admin code' });
        
    } catch (error) {
        console.error('Admin verification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check if user is admin
app.post('/api/auth/check-admin', async (req, res) => {
    try {
        const { username, twitchId } = req.body;
        const isAdmin = await isUserAdmin(username, twitchId);
        res.json({ success: true, isAdmin });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// API ENDPOINTS
// ============================================================

// Get user points and stats
app.get('/api/user/:viewer', async (req, res) => {
    try {
        const { viewer } = req.params;
        const platform = req.query.platform || 'twitch';
        console.log(`📡 API call for user: ${viewer} on platform: ${platform}`);
        const result = await getBotRixUserStatsByUsername(viewer, platform);
        if (result.success) {
            res.json({ 
                success: true, 
                points: result.points, 
                stats: result,
                platform: platform,
                timestamp: Date.now()
            });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Place a bet
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userId, viewerName, betAmount, twitchId, platform } = req.body;
        
        const twitchUserId = twitchId || userId;
        const platformValue = platform || 'twitch';
        
        const existingBet = await db.collection('bets').findOne({ 
            viewerName: viewerName.toLowerCase(), 
            status: 'pending',
            platform: platformValue
        });
        
        if (existingBet) {
            return res.json({ success: false, message: 'You already have a pending bet! Wait for resolution.' });
        }
        
        const userStats = await getBotRixUserStatsByUsername(viewerName, platformValue);
        if (!userStats.success) {
            return res.json({ success: false, message: 'Could not verify points' });
        }
        
        if (userStats.points < betAmount) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! You have ${userStats.points}, need ${betAmount}.` 
            });
        }
        
        const spendResult = await spendBotRixPoints(twitchUserId, betAmount, platformValue, `Wheel Bet: ${betAmount} points`);
        if (!spendResult.success) {
            return res.json({ success: false, message: 'Failed to deduct points. Please try again.' });
        }
        
        const betEntry = {
            userId: userId,
            twitchId: twitchUserId,
            viewerName: viewerName.toLowerCase(),
            betAmount: betAmount,
            platform: platformValue,
            status: 'pending',
            createdAt: new Date()
        };
        
        const result = await db.collection('bets').insertOne(betEntry);
        
        const freshStats = await getBotRixUserStatsByUsername(viewerName, platformValue);
        
        res.json({ 
            success: true, 
            message: `Bet placed! ${betAmount} points deducted. Waiting for result.`,
            newPoints: freshStats.success ? freshStats.points : userStats.points - betAmount,
            betId: result.insertedId
        });
        
    } catch (error) {
        console.error('Error placing bet:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all pending bets (for admin)
app.get('/api/pending-bets', async (req, res) => {
    try {
        const bets = await db.collection('bets')
            .find({ status: 'pending' })
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve ALL pending bets as WIN
app.post('/api/resolve-all-win', async (req, res) => {
    try {
        const pendingBets = await db.collection('bets').find({ status: 'pending' }).toArray();
        
        if (pendingBets.length === 0) {
            return res.json({ success: false, message: 'No pending bets to resolve.' });
        }
        
        let results = [];
        let successCount = 0;
        
        for (const bet of pendingBets) {
            const winAmount = bet.betAmount * 24;
            const platformValue = bet.platform || 'twitch';
            
            const addResult = await addBotRixPoints(bet.twitchId, winAmount, platformValue, `Wheel Bet WIN - ${winAmount} points`);
            
            if (addResult.success) {
                await db.collection('bets').updateOne(
                    { _id: bet._id },
                    { $set: { status: 'win', winAmount: winAmount, resolvedAt: new Date() } }
                );
                successCount++;
                results.push({ viewer: bet.viewerName, platform: platformValue, status: 'win', amount: winAmount });
            } else {
                results.push({ viewer: bet.viewerName, platform: platformValue, status: 'failed', error: 'API error' });
            }
        }
        
        res.json({ 
            success: true, 
            message: `🎉 Processed ${successCount} wins!`,
            results: results,
            timestamp: Date.now()
        });
        
    } catch (error) {
        console.error('Error in resolve-all-win:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve ALL pending bets as LOSS
app.post('/api/resolve-all-loss', async (req, res) => {
    try {
        const result = await db.collection('bets').updateMany(
            { status: 'pending' },
            { $set: { status: 'loss', resolvedAt: new Date() } }
        );
        
        res.json({ 
            success: true, 
            message: `💀 Processed ${result.modifiedCount} losses.`,
            timestamp: Date.now()
        });
        
    } catch (error) {
        console.error('Error in resolve-all-loss:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user's bet history
app.get('/api/bets/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const bets = await db.collection('bets')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'BotRix API is running!', 
        mongodb: db ? 'connected' : 'disconnected',
        streamer: STREAMER_NAME
    });
});

// Start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📍 Streamer: ${STREAMER_NAME}`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
