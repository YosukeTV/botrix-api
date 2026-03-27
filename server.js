const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// BOTRIX.LIVE CONFIGURATION
// ============================================================
const BOTRIX_API_BASE = "https://botrix.live/api";
const BOTRIX_BID = "fgMhJa9/7J06PwfKOA7Ayg";
const BOTRIX_PLATFORM = "twitch";
const STREAMER_NAME = "YosukeTV";

// CORS configuration
app.use(cors({
    origin: function (origin, callback) {
        callback(null, true);
    },
    credentials: true
}));
app.use(express.json());

// Database connection (for spin history)
const MONGODB_URI = process.env.MONGODB_URI;
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        
        await client.connect();
        db = client.db('botrix');
        console.log('✅ Connected to MongoDB');
        
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        if (!collectionNames.includes('wheel_spins')) {
            await db.createCollection('wheel_spins');
            console.log('✅ Created wheel_spins collection');
        }
        
        console.log('✅ Database ready');
        
    } catch (error) {
        console.error('❌ Database connection error:', error);
        throw error;
    }
}

// ============================================================
// BOTRIX PUBLIC API - GET USER STATS (Points, Level, Watchtime, etc.)
// ============================================================

async function getBotRixUserStats(viewerName) {
    try {
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}`;
        
        console.log(`Fetching stats for ${viewerName}: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        
        // API returns an array of user objects or empty array if not found
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
            console.log(`✅ Found ${viewerName}: ${userData.points} points, level ${userData.level}`);
            return { 
                success: true, 
                points: userData.points || 0,
                level: userData.level || 0,
                watchtime: userData.watchtime || 0,
                xp: userData.xp || 0,
                name: userData.name,
                followage: userData.followage || 0
            };
        }
        
        // User not found (0 points, new viewer)
        console.log(`⚠️ User ${viewerName} not found, returning defaults`);
        return { 
            success: true, 
            points: 0,
            level: 0,
            watchtime: 0,
            xp: 0,
            name: viewerName,
            followage: 0
        };
        
    } catch (error) {
        console.error('Error fetching BotRix stats:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// BOTRIX PRIVATE API - SPEND / ADD POINTS
// ============================================================

async function spendBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${amount}&bid=${BOTRIX_BID}`;
        
        console.log(`Spending ${amount} points for ${userId}`);
        const response = await fetch(url);
        const data = await response.json();
        
        return { success: data.success === true };
        
    } catch (error) {
        console.error('Error spending points:', error);
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${-amount}&bid=${BOTRIX_BID}`;
        
        console.log(`Adding ${amount} points to ${userId}`);
        const response = await fetch(url);
        const data = await response.json();
        
        return { success: data.success === true };
        
    } catch (error) {
        console.error('Error adding points:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// Get user points and stats
app.get('/api/user/:viewer', async (req, res) => {
    try {
        const { viewer } = req.params;
        
        const result = await getBotRixUserStats(viewer);
        
        if (result.success) {
            res.json({ 
                success: true, 
                points: result.points,
                stats: {
                    level: result.level,
                    watchtime: result.watchtime,
                    xp: result.xp,
                    followage: result.followage
                }
            });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initiate a wheel spin (deduct points)
app.post('/api/join-pool', async (req, res) => {
    try {
        const { userId, streamerName, viewerName, poolId, poolName, cost } = req.body;
        
        // Check if user has enough points
        const userStats = await getBotRixUserStats(viewerName);
        
        if (!userStats.success) {
            return res.json({ success: false, message: 'Could not verify points' });
        }
        
        if (userStats.points < cost) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! You have ${userStats.points}, need ${cost}.` 
            });
        }
        
        // Spend points via BotRix API
        const spendResult = await spendBotRixPoints(userId, cost, `Wheel Spin: ${poolName}`);
        
        if (!spendResult.success) {
            return res.json({ success: false, message: 'Failed to spend points' });
        }
        
        // Record the spin in database
        const spinEntry = {
            userId: userId,
            viewerName: viewerName.toLowerCase(),
            streamerName: streamerName.toLowerCase(),
            betAmount: cost,
            status: 'pending',
            createdAt: new Date()
        };
        
        const result = await db.collection('wheel_spins').insertOne(spinEntry);
        
        res.json({ 
            success: true, 
            message: `Spin initiated! Bet: ${cost} points. Waiting for result.`,
            newPoints: userStats.points - cost,
            spinId: result.insertedId
        });
        
    } catch (error) {
        console.error('Error in /api/join-pool:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve spin - WIN
app.post('/api/resolve-win', async (req, res) => {
    try {
        const { spinId, viewerName, betAmount } = req.body;
        
        const winAmount = betAmount * 24;
        
        // Add points via BotRix API
        const addResult = await addBotRixPoints(viewerName, winAmount, 'Wheel Spin Win');
        
        if (!addResult.success) {
            return res.json({ success: false, message: 'Failed to award points' });
        }
        
        // Mark spin as resolved
        await db.collection('wheel_spins').updateOne(
            { _id: new ObjectId(spinId) },
            { $set: { status: 'win', winAmount: winAmount, resolvedAt: new Date() } }
        );
        
        // Get updated stats
        const newStats = await getBotRixUserStats(viewerName);
        
        res.json({ 
            success: true, 
            message: `WIN! ${viewerName} won ${winAmount} points!`,
            newPoints: newStats.success ? newStats.points : null
        });
        
    } catch (error) {
        console.error('Error resolving win:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve spin - LOSS
app.post('/api/resolve-loss', async (req, res) => {
    try {
        const { spinId, viewerName } = req.body;
        
        await db.collection('wheel_spins').updateOne(
            { _id: new ObjectId(spinId) },
            { $set: { status: 'loss', resolvedAt: new Date() } }
        );
        
        // Get updated stats
        const newStats = await getBotRixUserStats(viewerName);
        
        res.json({ 
            success: true, 
            message: `LOSS confirmed for ${viewerName}. Points already deducted.`,
            newPoints: newStats.success ? newStats.points : null
        });
        
    } catch (error) {
        console.error('Error resolving loss:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user's spin history
app.get('/api/entries/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const spins = await db.collection('wheel_spins')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json({ success: true, entries: spins });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get pending spins (for admin)
app.get('/api/pending-spins', async (req, res) => {
    try {
        const spins = await db.collection('wheel_spins')
            .find({ status: 'pending' })
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json({ success: true, spins });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'BotRix API is running!',
        mongodb: db ? 'connected' : 'disconnected',
        platform: BOTRIX_PLATFORM,
        streamer: STREAMER_NAME
    });
});

// Start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📍 Platform: ${BOTRIX_PLATFORM}`);
        console.log(`📍 Streamer: ${STREAMER_NAME}`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
