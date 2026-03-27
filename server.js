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
        
        console.log('✅ Database ready');
    } catch (error) {
        console.error('❌ Database connection error:', error);
        throw error;
    }
}

// ============================================================
// BOTRIX PUBLIC API - GET USER STATS
// ============================================================

async function getBotRixUserStats(viewerName) {
    try {
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
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
        return { success: true, points: 0, level: 0, watchtime: 0, xp: 0, name: viewerName, followage: 0 };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function spendBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${amount}&bid=${BOTRIX_BID}`;
        const response = await fetch(url);
        const data = await response.json();
        return { success: data.success === true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(userId, amount, reason) {
    try {
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(userId)}&platform=${BOTRIX_PLATFORM}&points=${-amount}&bid=${BOTRIX_BID}`;
        const response = await fetch(url);
        const data = await response.json();
        return { success: data.success === true };
    } catch (error) {
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
            res.json({ success: true, points: result.points, stats: result });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Place a bet (deduct points immediately)
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userId, viewerName, betAmount } = req.body;
        
        // Check if user already has a pending bet
        const existingBet = await db.collection('bets').findOne({ 
            viewerName: viewerName.toLowerCase(), 
            status: 'pending' 
        });
        
        if (existingBet) {
            return res.json({ success: false, message: 'You already have a pending bet! Wait for resolution.' });
        }
        
        // Get user's current points
        const userStats = await getBotRixUserStats(viewerName);
        if (!userStats.success) {
            return res.json({ success: false, message: 'Could not verify points' });
        }
        
        if (userStats.points < betAmount) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! You have ${userStats.points}, need ${betAmount}.` 
            });
        }
        
        // Spend points via BotRix API
        const spendResult = await spendBotRixPoints(userId, betAmount, `Wheel Bet: ${betAmount} points`);
        if (!spendResult.success) {
            return res.json({ success: false, message: 'Failed to deduct points' });
        }
        
        // Record the bet in database
        const betEntry = {
            userId: userId,
            viewerName: viewerName.toLowerCase(),
            betAmount: betAmount,
            status: 'pending',
            createdAt: new Date()
        };
        
        const result = await db.collection('bets').insertOne(betEntry);
        
        res.json({ 
            success: true, 
            message: `Bet placed! ${betAmount} points deducted. Waiting for result.`,
            newPoints: userStats.points - betAmount,
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
        
        // Get current points for each bettor
        const betsWithPoints = await Promise.all(bets.map(async (bet) => {
            const stats = await getBotRixUserStats(bet.viewerName);
            return {
                ...bet,
                currentPoints: stats.success ? stats.points : 0
            };
        }));
        
        res.json({ success: true, bets: betsWithPoints });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve bet - WIN (award 24x points)
app.post('/api/resolve-win', async (req, res) => {
    try {
        const { betId, viewerName, betAmount } = req.body;
        
        const winAmount = betAmount * 24;
        
        // Add points via BotRix API
        const addResult = await addBotRixPoints(viewerName, winAmount, 'Wheel Bet Win - 24x');
        
        if (!addResult.success) {
            return res.json({ success: false, message: 'Failed to award points' });
        }
        
        // Mark bet as resolved
        await db.collection('bets').updateOne(
            { _id: new ObjectId(betId) },
            { $set: { status: 'win', winAmount: winAmount, resolvedAt: new Date() } }
        );
        
        const newStats = await getBotRixUserStats(viewerName);
        
        res.json({ 
            success: true, 
            message: `WIN! ${viewerName} won ${winAmount} points! (${betAmount} × 24)`,
            newPoints: newStats.success ? newStats.points : null
        });
        
    } catch (error) {
        console.error('Error resolving win:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve bet - LOSS (points already deducted)
app.post('/api/resolve-loss', async (req, res) => {
    try {
        const { betId, viewerName } = req.body;
        
        await db.collection('bets').updateOne(
            { _id: new ObjectId(betId) },
            { $set: { status: 'loss', resolvedAt: new Date() } }
        );
        
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
    res.json({ status: 'BotRix API is running!', mongodb: db ? 'connected' : 'disconnected' });
});

connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => process.exit(1));
