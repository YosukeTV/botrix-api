const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const MONGODB_URI = process.env.MONGODB_URI;
let db;

async function connectDB() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('botrix');
        console.log('✅ Connected to MongoDB');
        
        await db.createCollection('users');
        await db.createCollection('pool_entries');
        console.log('✅ Collections ready');
    } catch (error) {
        console.error('Database connection error:', error);
    }
}

// API Routes
app.get('/api/points/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        let user = await db.collection('users').findOne({ twitchId });
        
        if (!user) {
            user = {
                twitchId,
                points: 1250,
                createdAt: new Date()
            };
            await db.collection('users').insertOne(user);
        }
        
        res.json({ success: true, points: user.points });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/join-pool', async (req, res) => {
    try {
        const { twitchId, poolId, poolName, cost } = req.body;
        
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
            return res.json({ success: false, message: 'User not found' });
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
            { $set: { points: newPoints } }
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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/entries/:twitchId', async (req, res) => {
    try {
        const { twitchId } = req.params;
        
        const entries = await db.collection('pool_entries')
            .find({ twitchId })
            .toArray();
        
        res.json({ success: true, entries });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'BotRix API is running!' });
});

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
