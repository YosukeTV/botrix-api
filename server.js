const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// BOTRIX.LIVE CONFIGURATION
// ============================================================
const BOTRIX_API_BASE = "https://botrix.live/api";
const BOTRIX_BID = "7J06PwfKOA7Ayg"; // Your BotRix secret ID (bid)
const BOTRIX_PLATFORM = "twitch"; // or "twitch" depending on your platform

// CORS configuration
const allowedOrigins = [
    'https://yosuketv.github.io',
    'https://YosukeTV.github.io',
    'http://localhost:3000',
    'http://localhost:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(null, true);
        }
    },
    credentials: true
}));
app.use(express.json());

// Database connection (for storing pool entries)
const MONGODB_URI = process.env.MONGODB_URI;
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            connectTimeoutMS: 30000,
            serverSelectionTimeoutMS: 30000
        });
        
        await client.connect();
        db = client.db('botrix');
        console.log('✅ Connected to MongoDB');
        
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        if (!collectionNames.includes('pool_entries')) {
            await db.createCollection('pool_entries');
            console.log('✅ Created pool_entries collection');
        }
        
        console.log('✅ Database ready');
        
    } catch (error) {
        console.error('❌ Database connection error:', error);
        throw error;
    }
}

// ============================================================
// BOTRIX.LIVE API INTEGRATION
// ============================================================

/**
 * Get user points from BotRix leaderboard
 * Using: GET /api/public/leaderboard?platform=kick&user={streamer}&search={viewerName}
 */
async function getBotRixPoints(streamerName, viewerName) {
    try {
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(streamerName)}&search=${encodeURIComponent(viewerName)}`;
        console.log(`Fetching points from: ${url}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`BotRix API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Parse the response to find the user's points
        // The leaderboard returns an array of users with points
        if (data && Array.isArray(data) && data.length > 0) {
            // Find the matching user
            const user = data.find(u => u.name?.toLowerCase() === viewerName.toLowerCase());
            if (user) {
                return { success: true, points: user.points || 0 };
            }
        }
        
        // User not found on leaderboard (0 points)
        return { success: true, points: 0 };
        
    } catch (error) {
        console.error('Error fetching BotRix points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Spend points via BotRix API
 * Using: GET /api/extension/substractPoints?uid={userId}&platform=kick&points={amount}&bid={secret}
 */
async function spendBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${amount}&bid=${BOTRIX_BID}`;
        console.log(`Spending points via: ${url}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`BotRix API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        return { 
            success: data.success === true, 
            message: data.success ? `Successfully spent ${amount} points` : 'Failed to spend points'
        };
        
    } catch (error) {
        console.error('Error spending BotRix points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Refund points (add back) - use negative amount
 */
async function refundBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${-amount}&bid=${BOTRIX_BID}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        return { success: data.success === true };
        
    } catch (error) {
        console.error('Error refunding BotRix points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get user level from BotRix
 * Using: GET /api/extension/userLevel?uid={uid}&platform=kick&level={level}&bid={secret}
 */
async function getUserLevel(userId) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/userLevel?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&level=0&bid=${BOTRIX_BID}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        return { success: true, level: data.level || 0 };
        
    } catch (error) {
        console.error('Error fetching user level:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// API ENDPOINTS FOR YOUR FRONTEND
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'BotRix API is running!',
        botrix: 'Connected',
        mongodb: db ? 'connected' : 'disconnected',
        platform: BOTRIX_PLATFORM
    });
});

// Get user's BotRix points
app.get('/api/points/:streamer/:viewer', async (req, res) => {
    try {
        const { streamer, viewer } = req.params;
        
        const result = await getBotRixPoints(streamer, viewer);
        
        if (result.success) {
            res.json({ success: true, points: result.points });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error in /api/points:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Spend points to join a pool
app.post('/api/join-pool', async (req, res) => {
    try {
        const { userId, streamerName, viewerName, poolId, poolName, cost } = req.body;
        
        if (!userId || !streamerName || !viewerName || !poolId || !poolName || !cost) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }
        
        // Check if user already entered this pool
        const existingEntry = await db.collection('pool_entries').findOne({
            userId,
            poolId
        });
        
        if (existingEntry) {
            return res.json({ 
                success: false, 
                message: 'You already entered this pool!' 
            });
        }
        
        // Get current points from BotRix to verify
        const pointsResult = await getBotRixPoints(streamerName, viewerName);
        
        if (!pointsResult.success) {
            return res.json({ 
                success: false, 
                message: 'Could not verify your points balance' 
            });
        }
        
        if (pointsResult.points < cost) {
            return res.json({ 
                success: false, 
                message: `Insufficient BotRix points! You have ${pointsResult.points}, need ${cost}.` 
            });
        }
        
        // Spend points via BotRix API
        const spendResult = await spendBotRixPoints(userId, cost, `Joined pool: ${poolName}`);
        
        if (!spendResult.success) {
            return res.json({ 
                success: false, 
                message: `Failed to spend points: ${spendResult.error || 'Unknown error'}` 
            });
        }
        
        // Record the pool entry
        await db.collection('pool_entries').insertOne({
            userId,
            viewerName,
            streamerName,
            poolId,
            poolName,
            cost,
            joinedAt: new Date()
        });
        
        res.json({ 
            success: true, 
            message: `Successfully joined ${poolName}! Spent ${cost} BotRix points.`,
            newPoints: pointsResult.points - cost
        });
        
    } catch (error) {
        console.error('Error in /api/join-pool:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user's pool entries
app.get('/api/entries/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const entries = await db.collection('pool_entries')
            .find({ userId })
            .sort({ joinedAt: -1 })
            .toArray();
        
        res.json({ success: true, entries });
    } catch (error) {
        console.error('Error in /api/entries:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 BotRix API Server running on port ${PORT}`);
        console.log(`📍 Platform: ${BOTRIX_PLATFORM}`);
        console.log(`📍 BotRix API: ${BOTRIX_API_BASE}`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (client) {
        await client.close();
        console.log('✅ MongoDB connection closed');
    }
    process.exit(0);
});
