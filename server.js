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

// Cache for user data
let userDataCache = {};

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
// BOTRIX API - GET USER DATA
// ============================================================

async function getBotRixUserData(viewerName) {
    try {
        // Check cache first
        if (userDataCache[viewerName.toLowerCase()]) {
            return userDataCache[viewerName.toLowerCase()];
        }
        
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}`;
        console.log(`Fetching user data from: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
            console.log(`Found user: ${userData.name}, points: ${userData.points}`);
            
            const result = {
                success: true,
                points: userData.points || 0,
                level: userData.level || 0,
                watchtime: userData.watchtime || 0,
                xp: userData.xp || 0,
                name: userData.name,
                followage: userData.followage || 0,
                botrixUserId: viewerName // Using username as fallback
            };
            
            userDataCache[viewerName.toLowerCase()] = result;
            return result;
        }
        
        return { 
            success: true, 
            points: 0, 
            level: 0, 
            watchtime: 0, 
            xp: 0, 
            name: viewerName, 
            followage: 0, 
            botrixUserId: viewerName 
        };
        
    } catch (error) {
        console.error('Error fetching user data:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// BOTRIX PRIVATE API - SPEND / ADD POINTS
// ============================================================

async function spendBotRixPoints(userName, amount, reason) {
    try {
        const uid = userName;
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(uid)}&platform=${BOTRIX_PLATFORM}&points=${amount}&bid=${BOTRIX_BID}`;
        console.log(`🔴 Spending ${amount} points for ${userName}`);
        console.log(`🔴 URL: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`🔴 Response:`, data);
        
        return { success: data.success === true, data: data };
    } catch (error) {
        console.error('Error spending points:', error);
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(userName, amount, reason) {
    try {
        const uid = userName;
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(uid)}&platform=${BOTRIX_PLATFORM}&points=${-amount}&bid=${BOTRIX_BID}`;
        console.log(`🟢 Adding ${amount} points to ${userName}`);
        console.log(`🟢 URL: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`🟢 Response:`, data);
        
        return { success: data.success === true, data: data };
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
        const result = await getBotRixUserData(viewer);
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
        const userStats = await getBotRixUserData(viewerName);
        if (!userStats.success) {
            return res.json({ success: false, message: 'Could not verify points' });
        }
        
        if (userStats.points < betAmount) {
            return res.json({ 
                success: false, 
                message: `Insufficient points! You have ${userStats.points}, need ${betAmount}.` 
            });
        }
        
        // Spend points via BotRix API (DEDUCT)
        const spendResult = await spendBotRixPoints(viewerName, betAmount, `Wheel Bet: ${betAmount} points`);
        if (!spendResult.success) {
            return res.json({ success: false, message: `Failed to deduct points. API response: ${JSON.stringify(spendResult.data)}` });
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
        
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Resolve ALL pending bets as WIN (award 24x points to everyone)
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
            
            // Add points via BotRix API
            const addResult = await addBotRixPoints(bet.viewerName, winAmount, `Wheel Bet WIN - ${winAmount} points`);
            
            if (addResult.success) {
                await db.collection('bets').updateOne(
                    { _id: bet._id },
                    { $set: { status: 'win', winAmount: winAmount, resolvedAt: new Date() } }
                );
                successCount++;
                results.push({ viewer: bet.viewerName, status: 'win', amount: winAmount });
            } else {
                results.push({ viewer: bet.viewerName, status: 'failed', error: 'API error', response: addResult.data });
            }
        }
        
        res.json({ 
            success: true, 
            message: `🎉 Processed ${successCount} wins! ${successCount} viewers won their bets!`,
            results: results
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
            message: `💀 Processed ${result.modifiedCount} losses. Points were already deducted. Better luck next time!`
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

// ============================================================
// DEBUG ENDPOINTS
// ============================================================

// Test spend points directly
app.get('/api/debug/test-spend/:username/:points', async (req, res) => {
    try {
        const { username, points } = req.params;
        const result = await spendBotRixPoints(username, parseInt(points), 'Debug test');
        const testUrl = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${username}&platform=${BOTRIX_PLATFORM}&points=${points}&bid=${BOTRIX_BID}`;
        
        res.json({ 
            testUrl: testUrl,
            username: username,
            points: points,
            result: result
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Test add points directly
app.get('/api/debug/test-add/:username/:points', async (req, res) => {
    try {
        const { username, points } = req.params;
        const result = await addBotRixPoints(username, parseInt(points), 'Debug test');
        const testUrl = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${username}&platform=${BOTRIX_PLATFORM}&points=${-points}&bid=${BOTRIX_BID}`;
        
        res.json({ 
            testUrl: testUrl,
            username: username,
            points: points,
            result: result
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Check user points
app.get('/api/debug/user/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const userData = await getBotRixUserData(username);
        res.json(userData);
    } catch (error) {
        res.json({ error: error.message });
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
        console.log(`📍 Debug endpoints:`);
        console.log(`   GET /api/debug/test-spend/:username/:points`);
        console.log(`   GET /api/debug/test-add/:username/:points`);
        console.log(`   GET /api/debug/user/:username`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
