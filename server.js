const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const allowedOrigins = [
    'https://yosuketv.github.io',
    'https://YosukeTV.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('⚠️ Blocked origin:', origin);
            callback(null, true);
        }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.use(express.json());

app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no origin'}`);
    next();
});

app.options('*', cors(corsOptions));

// Database connection with SSL fixes
const MONGODB_URI = process.env.MONGODB_URI;
let db;
let client;

async function connectDB() {
    try {
        if (!MONGODB_URI) {
            throw new Error('MONGODB_URI environment variable is not set');
        }
        
        console.log('🔄 Connecting to MongoDB Atlas...');
        
        client = new MongoClient(MONGODB_URI, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            tls: true,
            tlsAllowInvalidCertificates: false,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 30000,
            serverSelectionTimeoutMS: 30000,
            retryWrites: true,
            retryReads: true
        });
        
        await client.connect();
        db = client.db('botrix');
        
        // Test connection
        await db.command({ ping: 1 });
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
        console.error('Connection string (hidden):', MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//****:****@'));
        throw error;
    }
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'BotRix API is running!',
        timestamp: new Date().toISOString(),
        mongodb: db ? 'connected' : 'disconnected',
        endpoints: [
            'GET  /api/points/:twitchId',
            'POST /api/join-pool',
            'GET  /api/entries/:twitchId',
            'GET  /'
        ]
    });
});

// API Endpoints (same as before)
app.get('/api/points/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        if (!twitchId) {
            return res.status(400).json({ success: false, error: 'twitchId is required' });
        }
        
        let user = await db.collection('users').findOne({ twitchId });
        
        if (!user) {
            user = {
                twitchId,
                points: 1250,
                createdAt: new Date(),
                lastActive: new Date()
            };
            await db.collection('users').insertOne(user);
            console.log(`✅ Created new user ${twitchId} with 1250 points`);
        } else {
            await db.collection('users').updateOne(
                { twitchId },
                { $set: { lastActive: new Date() } }
            );
        }
        
        res.json({ success: true, points: user.points });
    } catch (error) {
        console.error('Error in /api/points:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/join-pool', async (req, res) => {
    try {
        const { twitchId, poolId, poolName, cost } = req.body;
        
        if (!twitchId || !poolId || !poolName || !cost) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }
        
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
        
        const user = await db.collection('users').findOne({ twitchId });
        
        if (!user) {
            return res.json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        if (user.points < cost) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! Need ${cost}, you have ${user.points}` 
            });
        }
        
        const newPoints = user.points - cost;
        await db.collection('users').updateOne(
            { twitchId },
            { $set: { points: newPoints, lastActive: new Date() } }
        );
        
        await db.collection('pool_entries').insertOne({
            twitchId,
            poolId,
            poolName,
            cost,
            joinedAt: new Date()
        });
        
        res.json({ 
            success: true, 
            message: `Successfully joined ${poolName}!`,
            newPoints
        });
        
    } catch (error) {
        console.error('Error in /api/join-pool:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/entries/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        const entries = await db.collection('pool_entries')
            .find({ twitchId })
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
        console.log(`📍 CORS enabled for: ${allowedOrigins.join(', ')}`);
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
