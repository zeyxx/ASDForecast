# ASDForecast - Deployment Guide

## Feature Flags Configuration

All new features are **modular** and can be enabled/disabled via `config.js` without code changes.

### Location

Edit `config.js` and find the `FEATURES` section:

```javascript
FEATURES: {
    WEBSOCKET_ENABLED: true,           // Real-time WebSocket updates
    LOTTERY_ENABLED: true,             // Weekly ASDF lottery system
    REFERRAL_ENABLED: true,            // Referral/affiliate system with Golden Ratio decay
    BADGES_ENABLED: true,              // Achievement/badge system
    EXTERNAL_TRACKER_ENABLED: true,    // External wallet tracking service
    SENTIMENT_ENABLED: true            // Daily sentiment voting
}
```

### Feature Descriptions

| Feature | Description | Impact When Disabled |
|---------|-------------|---------------------|
| `WEBSOCKET_ENABLED` | Real-time price/state updates via WebSocket | Falls back to HTTP polling (2-10s intervals) |
| `LOTTERY_ENABLED` | Weekly ASDF lottery with holding-based tickets | Lottery endpoints return 404, UI section hidden |
| `REFERRAL_ENABLED` | Referral codes with Golden Ratio decay rewards | Referral endpoints return 404, UI section hidden |
| `BADGES_ENABLED` | Achievement badges (11 badges) | Badge endpoint returns 404, no badge checks |
| `EXTERNAL_TRACKER_ENABLED` | External wallet tracking service | Tracker service not started |
| `SENTIMENT_ENABLED` | Daily UP/DOWN sentiment voting | Voting UI hidden (if implemented) |

### Recommended Deployment Strategy

#### Phase 1: Base Platform (Minimal Risk)
```javascript
FEATURES: {
    WEBSOCKET_ENABLED: false,  // Keep HTTP polling for stability
    LOTTERY_ENABLED: false,
    REFERRAL_ENABLED: false,
    BADGES_ENABLED: false,
    EXTERNAL_TRACKER_ENABLED: false,
    SENTIMENT_ENABLED: true    // Already in production
}
```

#### Phase 2: Add WebSocket
```javascript
WEBSOCKET_ENABLED: true,  // Test real-time updates
```

#### Phase 3: Add Lottery
```javascript
LOTTERY_ENABLED: true,    // Test lottery eligibility checks
```

#### Phase 4: Add Referral
```javascript
REFERRAL_ENABLED: true,   // Test referral code creation/rewards
```

#### Phase 5: Add Badges
```javascript
BADGES_ENABLED: true,     // Test achievement system
```

---

## What Happens When Features Are Disabled

### Lottery Disabled
- `/api/lottery/*` endpoints are NOT registered (return 404)
- `lotteryState` is not loaded from disk
- Lottery UI section is automatically hidden in frontend
- Lottery scheduled tasks do not run
- No lottery-related calculations in payout flow

### Referral Disabled
- `/api/referral/*` endpoints are NOT registered (return 404)
- `referralData` is not loaded from disk
- Referral UI section is automatically hidden in frontend
- `processReferralRewards()` is skipped during payouts
- No referral reward calculations

### Badges Disabled
- `/api/user/badges` endpoint returns 404
- `checkAndAwardBadges()` is skipped after frame results
- No badge-related database updates

### WebSocket Disabled
- WebSocket server is not initialized
- `wsBroadcast()` calls are no-ops
- Frontend falls back to HTTP polling automatically
- Slightly higher latency for state updates (2-10s vs real-time)

---

## Startup Logs

When the server starts, it logs which features are enabled:

```
> [SYS] WebSocket server ENABLED
> [SYS] Lottery module ENABLED
> [SYS] Referral module ENABLED
> ASDForecast Engine v151.0 running on 3000
> Features: WS=true LOTTERY=true REFERRAL=true BADGES=true
```

Or when disabled:

```
> [SYS] WebSocket server DISABLED (HTTP polling only)
> [SYS] Lottery module DISABLED
> [SYS] Referral module DISABLED
> ASDForecast Engine v151.0 running on 3000
> Features: WS=false LOTTERY=false REFERRAL=false BADGES=false
```

---

## Data Files

Each feature stores its data in separate files under `RENDER_DISK_PATH` (default: `/var/data`):

| File | Feature | Created When |
|------|---------|--------------|
| `lottery_state.json` | Lottery | First lottery interaction |
| `referral_data.json` | Referral | First referral code creation |
| `user_activity.json` | Lottery | First user activity recorded |

**Note**: These files are only loaded if the corresponding feature is enabled.

---

## Testing Checklist

### With All Features OFF
- [ ] Server starts without errors
- [ ] Betting flow works (buy UP/DOWN)
- [ ] Payouts process correctly
- [ ] Frontend displays core betting UI only
- [ ] Lottery/Referral sections are hidden

### Enabling Lottery
- [ ] Lottery section appears in frontend
- [ ] `/api/lottery/eligibility` returns data
- [ ] Lottery scheduled task runs hourly
- [ ] Activity is recorded during betting

### Enabling Referral
- [ ] Referral section appears in frontend
- [ ] `/api/referral/code` works with wallet connected
- [ ] Referral rewards calculated during payouts
- [ ] Golden Ratio decay applied correctly

### Enabling WebSocket
- [ ] Console shows "WebSocket server ready"
- [ ] Frontend connects via WebSocket
- [ ] Real-time price/state updates work
- [ ] Graceful fallback if connection fails

---

## Environment Variables

These remain in `.env` (not in config.js):

```bash
HELIUS_API_KEY=your_key_here
FEE_WALLET_PRIVATE_KEY=base58_encoded
UPKEEP_WALLET_PRIVATE_KEY=base58_encoded
ADMIN_KEY=your_admin_secret
PORT=3000  # Optional, defaults to 3000
```

---

## Version Info

- Backend: v151.0
- Frontend: v147.0
- Config: Centralized in `config.js`

Generated with Claude Code
