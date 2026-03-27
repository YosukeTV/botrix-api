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

// Cache for user IDs (to avoid repeated API calls)
let userIdCache = {};

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
// BOTRIX API - GET USER ID (from leaderboard or user endpoint)
// ============================================================

async function getBotRixUserId(viewerName) {
    try {
        // Check cache first
        if (userIdCache[viewerName.toLowerCase()]) {
            return { success: true, userId: userIdCache[viewerName.toLowerCase()] };
        }
        
        // Try to get user from leaderboard with search
        const url = `${BOTRIX_API_BASE}/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(STREAMER_NAME)}&search=${encodeURIComponent(viewerName)}`;
        console.log(`Fetching user ID from: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0];
            // The API returns user data but doesn't include a numeric ID in the public endpoint
            // For now, we'll use the username as a fallback, but this may not work for the private API
            
            // For private API, we need to try a different approach
            // Since BotRix private API uses username as uid (based on your earlier message)
            // Let's try using the username directly as uid
            
            console.log(`Found user: ${userData.name}, using username as uid`);
            userIdCache[viewerName.toLowerCase()] = viewerName;
            return { success: true, userId: viewerName };
        }
        
        // If not found, return username as fallback
        console.log(`User ${viewerName} not found, using username as uid`);
        return { success: true, userId: viewerName };
        
    } catch (error) {
        console.error('Error fetching user ID:', error);
        return { success: false, error: error.message };
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

// ============================================================
// BOTRIX PRIVATE API - SPEND / ADD POINTS
// ============================================================

async function spendBotRixPoints(userId, amount, reason) {
    try {
        // First get the user's numeric ID or use username
        const userIdResult = await getBotRixUserId(userId);
        if (!userIdResult.success) {
            return { success: false, error: 'Could not get user ID' };
        }
        
        const uid = userIdResult.userId;
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(uid)}&platform=${BOTRIX_PLATFORM}&points=${amount}&bid=${BOTRIX_BID}`;
        console.log(`Spending ${amount} points for ${userId} (uid: ${uid})`);
        console.log(`Full URL: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`Spend response:`, data);
        
        return { success: data.success === true };
    } catch (error) {
        console.error('Error spending points:', error);
        return { success: false, error: error.message };
    }
}

async function addBotRixPoints(userId, amount, reason) {
    try {
        // First get the user's numeric ID or use username
        const userIdResult = await getBotRixUserId(userId);
        if (!userIdResult.success) {
            return { success: false, error: 'Could not get user ID' };
        }
        
        const uid = userIdResult.userId;
        const url = `${BOTRIX_API_BASE}/extension/substractPoints?uid=${encodeURIComponent(uid)}&platform=${BOTRIX_PLATFORM}&points=${-amount}&bid=${BOTRIX_BID}`;
        console.log(`Adding ${amount} points to ${userId} (uid: ${uid})`);
        console.log(`Full URL: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        console.log(`Add points response:`, data);
        
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
        
        // Spend points via BotRix API (DEDUCT) - use viewerName as the uid
        const spendResult = await spendBotRixPoints(viewerName, betAmount, `Wheel Bet: ${betAmount} points`);
        if (!spendResult.success) {
            return res.json({ success: false, message: 'Failed to deduct points. Please try again.' });
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
            
            // Add points via BotRix API (using negative points)
            const addResult = await addBotRixPoints(bet.viewerName, winAmount, `Wheel Bet WIN - ${winAmount} points`);
            
            if (addResult.success) {
                await db.collection('bets').updateOne(
                    { _id: bet._id },
                    { $set: { status: 'win', winAmount: winAmount, resolvedAt: new Date() } }
                );
                successCount++;
                results.push({ viewer: bet.viewerName, status: 'win', amount: winAmount });
            } else {
                results.push({ viewer: bet.viewerName, status: 'failed', error: 'API error' });
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

// Resolve ALL pending bets as LOSS (just mark as loss, points already deducted)
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
        console.log(`📍 BotRix BID: ${BOTRIX_BID.substring(0, 10)}...`);
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
