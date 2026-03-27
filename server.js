const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CORS CONFIGURATION - Allow requests from your GitHub Pages
// ============================================================

const allowedOrigins = [
    'https://yosuketv.github.io',
    'https://YosukeTV.github.io',
    'https://yosuketv.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

// CORS options
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('⚠️ Blocked origin:', origin);
            // For debugging, still allow but log it
            callback(null, true);
        }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Apply CORS middleware
app.use(cors(corsOptions));
app.use(express.json());

// Log all incoming requests for debugging
app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no origin'}`);
    next();
});

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

// ============================================================
// DATABASE CONNECTION
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('botrix');
        console.log('✅ Connected to MongoDB Atlas');
        
        // Create collections if they don't exist
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        if (!collectionNames.includes('users')) {
            await db.createCollection('users');
            console.log('✅ Created "users" collection');
        }
        
        if (!collectionNames.includes('pool_entries')) {
            await db.createCollection('pool_entries');
            console.log('✅ Created "pool_entries" collection');
        }
        
        console.log('✅ Database ready');
    } catch (error) {
        console.error('❌ Database connection error:', error);
        process.exit(1);
    }
}

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================

app.get('/', (req, res) => {
    res.json({ 
        status: 'BotRix API is running!',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET  /api/points/:twitchId',
            'POST /api/join-pool',
            'GET  /api/entries/:twitchId',
            'GET  /'
        ]
    });
});

// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * GET /api/points/:twitchId
 * Get or create user and return their points
 */
app.get('/api/points/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        if (!twitchId) {
            return res.status(400).json({ success: false, error: 'twitchId is required' });
        }
        
        console.log(`Fetching points for user: ${twitchId}`);
        
        let user = await db.collection('users').findOne({ twitchId });
        
        if (!user) {
            // New user gets 1250 points
            const newUser = {
                twitchId,
                points: 1250,
                createdAt: new Date(),
                lastActive: new Date()
            };
            await db.collection('users').insertOne(newUser);
            user = newUser;
            console.log(`✅ Created new user ${twitchId} with 1250 points`);
        } else {
            // Update last active timestamp
            await db.collection('users').updateOne(
                { twitchId },
                { $set: { lastActive: new Date() } }
            );
        }
        
        res.json({ 
            success: true, 
            points: user.points,
            userId: twitchId
        });
        
    } catch (error) {
        console.error('Error in /api/points:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/join-pool
 * Spend points to join a pool
 */
app.post('/api/join-pool', async (req, res) => {
    try {
        const { twitchId, poolId, poolName, cost } = req.body;
        
        if (!twitchId || !poolId || !poolName || !cost) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: twitchId, poolId, poolName, cost' 
            });
        }
        
        console.log(`Processing join: ${twitchId} -> ${poolName} (${cost} points)`);
        
        // Check if already entered this pool
        const existingEntry = await db.collection('pool_entries').findOne({
            twitchId,
            poolId
        });
        
        if (existingEntry) {
            return res.json({ 
                success: false, 
                message: 'You already entered this pool!' 
            });
        }
        
        // Get user and check points
        const user = await db.collection('users').findOne({ twitchId });
        
        if (!user) {
            return res.json({ 
                success: false, 
                message: 'User not found. Please login again.' 
            });
        }
        
        if (user.points < cost) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! Need ${cost}, you have ${user.points}` 
            });
        }
        
        // Deduct points
        const newPoints = user.points - cost;
        await db.collection('users').updateOne(
            { twitchId },
            { $set: { points: newPoints, lastActive: new Date() } }
        );
        
        // Record the entry
        await db.collection('pool_entries').insertOne({
            twitchId,
            poolId,
            poolName,
            cost,
            joinedAt: new Date(),
            status: 'active'
        });
        
        console.log(`✅ ${twitchId} joined ${poolName}. Points: ${user.points} -> ${newPoints}`);
        
        res.json({ 
            success: true, 
            message: `Successfully joined ${poolName}!`,
            newPoints: newPoints
        });
        
    } catch (error) {
        console.error('Error in /api/join-pool:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/entries/:twitchId
 * Get all pool entries for a user
 */
app.get('/api/entries/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        if (!twitchId) {
            return res.status(400).json({ success: false, error: 'twitchId is required' });
        }
        
        const entries = await db.collection('pool_entries')
            .find({ twitchId })
            .sort({ joinedAt: -1 })
            .toArray();
        
        res.json({ 
            success: true, 
            entries: entries.map(e => ({
                poolId: e.poolId,
                poolName: e.poolName,
                cost: e.cost,
                joinedAt: e.joinedAt
            }))
        });
        
    } catch (error) {
        console.error('Error in /api/entries:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/users/:twitchId/stats
 * Get user statistics (optional - for future features)
 */
app.get('/api/users/:twitchId/stats', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        const user = await db.collection('users').findOne({ twitchId });
        const entries = await db.collection('pool_entries').find({ twitchId }).toArray();
        const totalSpent = entries.reduce((sum, e) => sum + e.cost, 0);
        
        res.json({
            success: true,
            stats: {
                currentPoints: user?.points || 0,
                totalPoolsJoined: entries.length,
                totalPointsSpent: totalSpent,
                memberSince: user?.createdAt || null
            }
        });
        
    } catch (error) {
        console.error('Error in /api/users/stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error',
        message: err.message 
    });
});

// ============================================================
// START SERVER
// ============================================================

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 BotRix API Server is running on port ${PORT}`);
        console.log(`📍 CORS enabled for: ${allowedOrigins.join(', ')}`);
        console.log(`📡 API URL: http://localhost:${PORT}`);
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    if (client) {
        await client.close();
        console.log('✅ MongoDB connection closed');
    }
    process.exit(0);
});
