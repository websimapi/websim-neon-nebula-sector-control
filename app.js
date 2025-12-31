import { getHexGrid, hexToPixel, getKey, getNeighbors, hexDistance } from './hex_engine.js';

// --- CONFIG ---
const MAX_PLAYERS = 4;
const BOARD_RADIUS = 6;
const STARTING_ENERGY = 3;
const WIN_PCT = 0.8;
const COSTS = {
    DEPLOY: 2,
    FORTIFY: 1,
    OVERLOAD: 3
};

// --- TOAST SYSTEM ---
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerText = message;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.5s';
        setTimeout(() => el.remove(), 500);
    }, 3000);
}

// --- AUDIO ---
const sfx = {
    deploy: new Audio('sfx_deploy.mp3'),
    overload: new Audio('sfx_overload.mp3'),
    victory: new Audio('sfx_victory.mp3')
};
const playSound = (name) => {
    sfx[name].currentTime = 0;
    sfx[name].play().catch(e => {}); 
};

// --- DB HELPERS ---
async function getUserData() {
    try {
        const currentUser = await window.websim.getCurrentUser();
        // Use 'user_data_v1' collection
        const records = await room.collection('user_data_v1').filter({ username: currentUser.username }).getList();
        
        if (records.length === 0) {
            return await room.collection('user_data_v1').create({
                username: currentUser.username,
                col_1: { wins: 0, losses: 0, matches_played: 0, elo: 1000 },
                col_2: { history: [] }
            });
        }
        return records[0];
    } catch (e) {
        console.error("DB Error", e);
        return null;
    }
}

async function updateStats(isWinner, matchId) {
    const record = await getUserData();
    if (!record) return;

    const stats = record.col_1 || { wins: 0, losses: 0, matches_played: 0, elo: 1000 };
    const history = record.col_2?.history || [];

    stats.matches_played++;
    if (isWinner) {
        stats.wins++;
        stats.elo += 25;
    } else {
        stats.losses++;
        stats.elo = Math.max(0, stats.elo - 15);
    }

    history.unshift({
        id: matchId,
        result: isWinner ? 'WIN' : 'LOSS',
        date: new Date().toISOString()
    });
    if (history.length > 10) history.pop();

    await room.collection('user_data_v1').update(record.id, {
        col_1: stats,
        col_2: { history }
    });
}

// --- WEBSIM SETUP ---
const room = new WebsimSocket();

function Game() {
    const [status, setStatus] = React.useState('loading');
    const [peers, setPeers] = React.useState({});
    const [roomState, setRoomState] = React.useState({});
    const [presence, setPresence] = React.useState({});
    const [myId, setMyId] = React.useState(null);
    const [action, setAction] = React.useState(null);
    const [userStats, setUserStats] = React.useState(null);
    const [leaderboard, setLeaderboard] = React.useState([]);

    React.useEffect(() => {
        let cleanupRoom;
        let cleanupPresence;

        const init = async () => {
            await room.initialize();
            
            setPeers({ ...room.peers });
            setRoomState(room.roomState);
            setPresence(room.presence);
            setMyId(room.clientId);
            
            // Subscribe to room state
            cleanupRoom = room.subscribeRoomState(setRoomState);
            
            // Subscribe to presence (handles peers joining/leaving)
            cleanupPresence = room.subscribePresence((newPresence) => {
                setPresence(newPresence);
                setPeers({ ...room.peers });
            });

            // Fetch user stats
            const stats = await getUserData();
            setUserStats(stats?.col_1);

            // Fetch Leaderboard
            try {
                const allStats = await room.collection('user_data_v1').getList();
                const sorted = allStats.sort((a,b) => (b.col_1?.elo || 0) - (a.col_1?.elo || 0)).slice(0, 10);
                setLeaderboard(sorted);
            } catch(e) { console.warn("Leaderboard fetch failed", e); }

            // Initial Room State defaults
            if (!room.roomState.phase) {
                // Only host initializes if phase is missing
                if (Object.keys(room.peers)[0] === room.clientId) {
                    room.updateRoomState({
                        phase: 'lobby',
                        players: [],
                        board: {},
                        turnIndex: 0,
                        gameLog: [],
                        turnStartTime: Date.now()
                    });
                }
            }
            
            if (room.roomState.phase) setStatus(room.roomState.phase);
            else setStatus('lobby');
        };
        init();

        return () => {
            if (cleanupRoom) cleanupRoom();
            if (cleanupPresence) cleanupPresence();
        };
    }, []);

    React.useEffect(() => {
        if (roomState.phase) {
            setStatus(roomState.phase);
        }
    }, [roomState.phase]);

    // --- GAME ACTIONS ---

    const startGame = () => {
        const humanIds = Object.keys(peers);
        if (humanIds.length < 1) return; 

        // 1. Setup Players (Add AI if solo)
        const PERSONALITY_TYPES = ['AGGRESSIVE', 'DEFENSIVE', 'EXPANSIVE', 'BALANCED'];
        
        let players = humanIds.map((id, index) => ({
            id: id,
            isAI: false,
            colorIndex: index + 1,
            energy: STARTING_ENERGY,
            score: 0,
            username: peers[id].username
        }));

        // Fill with AI until 4 players
        if (players.length < MAX_PLAYERS) {
            const aiNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
            let aiCount = 0;
            while (players.length < MAX_PLAYERS) {
                const pType = PERSONALITY_TYPES[Math.floor(Math.random() * PERSONALITY_TYPES.length)];
                players.push({
                    id: `ai-${aiCount}`,
                    isAI: true,
                    personality: pType, 
                    colorIndex: players.length + 1,
                    energy: STARTING_ENERGY,
                    score: 0,
                    username: `Bot ${aiNames[aiCount]} [${pType.substring(0,3)}]`
                });
                aiCount++;
            }
        }

        // 2. Setup Grid with Terrain
        const grid = getHexGrid(BOARD_RADIUS);
        const board = {};
        grid.forEach(hex => {
            const dist = hexDistance(hex, {q:0, r:0});
            // 8% Void holes (exclude center area)
            if (dist > 2 && Math.random() < 0.08) return;

            let type = 'NORMAL';
            let item = null;
            
            // 15% Mountains (Defensive Bonus, Higher Cost)
            if (Math.random() < 0.15) type = 'MOUNTAIN';

            // 5% Powerups on normal tiles
            if (type === 'NORMAL' && Math.random() < 0.05) item = 'energy';

            board[getKey(hex)] = { ...hex, owner: null, strength: 0, type, item };
        });

        // 3. Assign Starts
        const starts = [];
        // Adjusted for radius 6
        if (players.length === 1) starts.push({q:0, r:0});
        else if (players.length === 2) { starts.push({q:0, r:-5}, {q:0, r:5}); }
        else {
             starts.push({q:0, r:-5}, {q:5, r:-5}, {q:5, r:0}, {q:0, r:5}, {q:-5, r:5}, {q:-5, r:0});
        }

        players.forEach((p, i) => {
            if (i < starts.length) {
                const hexKey = getKey(starts[i]);
                if (board[hexKey]) {
                    board[hexKey].owner = p.id;
                    board[hexKey].strength = 3;
                }
            }
        });

        room.updateRoomState({
            phase: 'playing',
            board,
            players,
            turnIndex: 0,
            totalTurns: 0,
            gameLog: ['Game Started!'],
            turnStartTime: Date.now()
        });
        
        playSound('deploy');
    };

    // AI Logic Loop (Sequential Moves)
    const aiRef = React.useRef(false);

    React.useEffect(() => {
        if (status !== 'playing' || !roomState.players) return;
        
        const currentPlayer = roomState.players[roomState.turnIndex];
        if (!currentPlayer?.isAI) return;

        // Host determines AI
        const connectedIds = Object.keys(peers).sort();
        const amIHost = connectedIds.length > 0 && connectedIds[0] === myId;
        
        if (amIHost && !aiRef.current) {
            aiRef.current = true;
            executeAITurnSequence(currentPlayer);
        }
    }, [roomState.turnIndex, roomState.phase, status, peers]);

    const delay = ms => new Promise(res => setTimeout(res, ms));

    const executeAITurnSequence = async (originalAiPlayer) => {
        // AI Personality Weights
        const weights = {
            BALANCED: { deploy: 1.0, overload: 1.0, fortify: 1.0 },
            AGGRESSIVE: { deploy: 0.8, overload: 1.4, fortify: 0.6 },
            DEFENSIVE: { deploy: 0.8, overload: 0.6, fortify: 1.4 },
            EXPANSIVE: { deploy: 1.4, overload: 0.8, fortify: 0.8 }
        };

        const personality = originalAiPlayer.personality || 'BALANCED';
        const w = weights[personality];

        // Small delay before starting turn
        await delay(1000);

        let moves = 0;
        let canMove = true;
        // Dynamic max moves to ensure AI spends energy if possible
        const MAX_MOVES = Math.max(8, originalAiPlayer.energy);

        // We fetch fresh state at start of each action
        while (canMove && moves < MAX_MOVES) {
            const freshState = room.roomState; // Get latest
            if (freshState.phase !== 'playing') break;
            
            let players = [...freshState.players];
            let board = { ...freshState.board };
            let turnIndex = freshState.turnIndex;
            let aiPlayer = players[turnIndex];

            // Verify it's still this AI's turn
            if (aiPlayer.id !== originalAiPlayer.id) break;
            if (aiPlayer.energy <= 0) break;

            // --- AI DECISION LOGIC ---
            let bestMove = null;
            let bestScore = -Infinity;

            const myTiles = Object.values(board).filter(t => t.owner === aiPlayer.id);
            const hasTiles = myTiles.length > 0;

            // 1. Evaluate DEPLOY moves
            if (aiPlayer.energy >= COSTS.DEPLOY) {
                let candidates = [];
                if (!hasTiles) {
                    // Respawn logic
                    candidates = Object.values(board).filter(t => !t.owner);
                } else {
                    const potentialKeys = new Set();
                    myTiles.forEach(t => {
                        getNeighbors(t).forEach(n => potentialKeys.add(getKey(n)));
                    });
                    candidates = Array.from(potentialKeys)
                        .map(k => board[k])
                        .filter(t => t && (!t.owner || !players.some(p => p.id === t.owner))); // Treat zombie as empty
                }

                candidates.forEach(target => {
                    const neighbors = getNeighbors(target);
                    // Heuristic: Prefer spots with more empty neighbors (expansion potential)
                    const emptyNeighbors = neighbors.filter(n => {
                        const cell = board[getKey(n)];
                        return cell && !cell.owner;
                    }).length;
                    
                    // Prefer spots connecting to my own territory strongly?
                    const myNeighbors = neighbors.filter(n => {
                        const cell = board[getKey(n)];
                        return cell && cell.owner === aiPlayer.id;
                    }).length;

                    // Base 10 + bonus
                    let rawScore = 10 + (emptyNeighbors * 2) + myNeighbors;
                    
                    // Prioritize Items
                    if (target.item === 'energy') rawScore += 25;
                    
                    // Mountains cost more but are defensive
                    if (target.type === 'MOUNTAIN') rawScore -= 5;

                    let score = rawScore * w.deploy;

                    if (score > bestScore) {
                        bestScore = score;
                        bestMove = { type: 'DEPLOY', target: target };
                    }
                });
            }

            // 2. Evaluate OVERLOAD moves (Attack)
            if (aiPlayer.energy >= COSTS.OVERLOAD) {
                const targets = [];
                myTiles.forEach(tile => {
                    getNeighbors(tile).forEach(n => {
                        const nKey = getKey(n);
                        const target = board[nKey];
                        // Target must be enemy
                        if (target && target.owner && target.owner !== aiPlayer.id) {
                            targets.push(target);
                        }
                    });
                });

                // Unique targets
                const uniqueTargets = [...new Set(targets)];

                uniqueTargets.forEach(target => {
                    const targetNeighbors = getNeighbors(target);
                    const mySupport = targetNeighbors.reduce((max, n) => {
                        const cell = board[getKey(n)];
                        return (cell && cell.owner === aiPlayer.id) ? Math.max(max, cell.strength) : max;
                    }, 0);

                    if (mySupport > target.strength) {
                        // We can kill it.
                        let rawScore = 25 + (target.strength * 4); 
                        let score = rawScore * w.overload;

                        if (score > bestScore) {
                            bestScore = score;
                            bestMove = { type: 'OVERLOAD', target: target };
                        }
                    }
                });
            }

            // 3. Evaluate FORTIFY moves (Defend)
            if (aiPlayer.energy >= COSTS.FORTIFY) {
                myTiles.forEach(tile => {
                    if (tile.strength >= 10) return; // Cap for AI

                    // Check if threatened
                    const neighbors = getNeighbors(tile);
                    const enemies = neighbors.filter(n => {
                        const c = board[getKey(n)];
                        return c && c.owner && c.owner !== aiPlayer.id;
                    });
                    
                    let rawScore = 0;
                    if (enemies.length > 0) {
                        // High priority if threatened
                        rawScore = 15 + (enemies.length * 5) + (5 - tile.strength);
                    } else {
                        // Low priority to just buff safe tiles
                        rawScore = 2; 
                    }

                    let score = rawScore * w.fortify;

                    if (score > bestScore) {
                        bestScore = score;
                        bestMove = { type: 'FORTIFY', target: tile };
                    }
                });
            }

            // Execute Best Move
            if (bestMove) {
                const k = getKey(bestMove.target);
                
                // Powerup Collection Logic
                if (board[k].item === 'energy') {
                    aiPlayer.energy += 5;
                    board[k].item = null;
                }

                // Terrain Cost Logic
                let moveCost = 0;
                if (bestMove.type === 'DEPLOY') moveCost = COSTS.DEPLOY;
                else if (bestMove.type === 'OVERLOAD') moveCost = COSTS.OVERLOAD;
                else if (bestMove.type === 'FORTIFY') moveCost = COSTS.FORTIFY;

                if (board[k].type === 'MOUNTAIN' && bestMove.type !== 'FORTIFY') {
                    moveCost += 1;
                }

                if (bestMove.type === 'DEPLOY') {
                    board[k] = { ...board[k], owner: aiPlayer.id, strength: 1 };
                    aiPlayer.energy -= moveCost;
                    playSound('deploy');
                } else if (bestMove.type === 'OVERLOAD') {
                    board[k] = { ...board[k], owner: aiPlayer.id, strength: Math.max(1, board[k].strength - 1) };
                    aiPlayer.energy -= moveCost;
                    playSound('overload');
                } else if (bestMove.type === 'FORTIFY') {
                    board[k].strength += 1;
                    aiPlayer.energy -= moveCost;
                    playSound('deploy');
                }

                // Update Scores & Check Domination
                players[turnIndex] = aiPlayer;
                const totalHexes = Object.keys(board).length;
                players.forEach(p => {
                    const owned = Object.values(board).filter(c => c.owner === p.id).length;
                    p.score = owned;
                    if (owned / totalHexes >= WIN_PCT) {
                        // Trigger instant win
                        players = players.map(pl => ({...pl, score: pl.id === p.id ? 999 : 0})); // Force end
                    }
                });

                // Update Room State
                await room.updateRoomState({
                    board,
                    players
                });
                
                // Check Win
                const alive = players.filter(p => p.score > 0);
                if (alive.length === 1 && players.length > 1) {
                    room.updateRoomState({
                        phase: 'gameover',
                        winner: alive[0].id
                    });
                    aiRef.current = false;
                    return; 
                }

                moves++;
                // Check if we can afford anything else
                if (aiPlayer.energy < 1) canMove = false;
                
                await delay(400); 
            } else {
                canMove = false; // No valid moves found
            }
        }

        // End Turn
        const finalState = room.roomState;
        let players = [...finalState.players];
        let turnIndex = finalState.turnIndex;
        
        let nextIndex = (turnIndex + 1) % players.length;
        let attempts = 0;
        while (players[nextIndex].score === 0 && attempts < players.length) {
             nextIndex = (nextIndex + 1) % players.length;
             attempts++;
        }
        
        // Handle Turn Counter & Income
        const currentTotalTurns = finalState.totalTurns || 0;
        const newTotalTurns = currentTotalTurns + 1;
        
        // Only give income if everyone has played at least once (Round 2+)
        // Or if it's an old game state (undefined check)
        if (finalState.totalTurns === undefined || newTotalTurns >= players.length) {
            const nextId = players[nextIndex].id;
            const count = Object.values(finalState.board).filter(c => c.owner === nextId).length;
            const income = 2 + Math.floor(count / 3);
            players[nextIndex].energy += income;
        }

        await room.updateRoomState({
            players,
            turnIndex: nextIndex,
            totalTurns: newTotalTurns,
            turnStartTime: Date.now()
        });

        aiRef.current = false;
    };

    const handleHexClick = (hex) => {
        if (status !== 'playing') return;
        
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (myPlayerIndex === -1) {
            showToast("You are spectating");
            return;
        }
        if (roomState.turnIndex !== myPlayerIndex) {
            showToast("Not your turn!");
            return;
        }
        if (!action) {
            showToast("Select an action first (Deploy, Fortify, Overload)");
            return;
        }

        const key = getKey(hex);
        const cell = roomState.board[key];
        if (!cell) return;

        let newBoard = JSON.parse(JSON.stringify(roomState.board));
        let newPlayers = JSON.parse(JSON.stringify(roomState.players));
        let currentPlayer = newPlayers[myPlayerIndex];
        let actionSuccess = false;

        // Terrain & Cost Logic
        let cost = 0;
        if (action === 'deploy') cost = COSTS.DEPLOY;
        else if (action === 'fortify') cost = COSTS.FORTIFY;
        else if (action === 'overload') cost = COSTS.OVERLOAD;

        if (cell.type === 'MOUNTAIN' && action !== 'fortify') cost += 1;

        if (currentPlayer.energy < cost) {
            showToast(`Need ${cost} energy (Terrain Penalty: ${cell.type==='MOUNTAIN' && action!=='fortify' ? '+1' : '0'})`);
            return;
        }

        if (action === 'deploy') {
            const isOccupied = cell.owner && roomState.players.some(p => p.id === cell.owner);
            if (isOccupied) {
                showToast("Target must be empty!");
                return;
            }

            const neighbors = getNeighbors(hex);
            const hasNeighbor = neighbors.some(n => {
                const nCell = roomState.board[getKey(n)];
                return nCell && nCell.owner === myId;
            });
            const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);

            if (!hasNeighbor && hasAnyTile) {
                showToast("Must deploy adjacent to your territory");
                return;
            }

            newBoard[key].owner = myId;
            newBoard[key].strength = 1;
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('deploy');

        } else if (action === 'fortify') {
            if (cell.owner !== myId) {
                showToast("Can only fortify your own tiles");
                return;
            }
            const cap = cell.type === 'MOUNTAIN' ? 15 : 10;
            if (cell.strength >= cap) {
                 showToast(`Maximum strength reached (${cap})`);
                 return;
            }

            newBoard[key].strength += 1;
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('deploy');

        } else if (action === 'overload') {
            if (cell.owner === null || cell.owner === myId) {
                showToast("Must target an enemy tile");
                return;
            }

            const neighbors = getNeighbors(hex);
            const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                const nCell = roomState.board[getKey(n)];
                if (nCell && nCell.owner === myId) return Math.max(maxStr, nCell.strength);
                return maxStr;
            }, 0);

            if (myStrongestAdj <= 0) {
                 showToast("Must be adjacent to your tile");
                 return;
            }
            if (myStrongestAdj <= cell.strength) {
                showToast(`Insufficient power! Need > ${cell.strength} strength nearby.`);
                return;
            }

            newBoard[key].owner = myId;
            newBoard[key].strength = Math.max(1, cell.strength - 1);
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('overload');
        }

        if (actionSuccess) {
            // Collect Item
            if (newBoard[key].item === 'energy' && action !== 'overload') { // Cannot collect if overloading enemy? Actually if you capture it you should.
               // If overload success (tile flips), or deploy success
               // Actually overload flips it immediately in this logic, so yes.
               currentPlayer.energy += 5;
               newBoard[key].item = null;
               showToast("Energy Cache Collected! +5⚡");
            }
            // Note: If overloading and not capturing (just reducing strength), item remains?
            // Current overload logic: newBoard[key].owner = myId immediately if successful.
            
            const totalHexes = Object.keys(newBoard).length;

            newPlayers.forEach(p => {
                const owned = Object.values(newBoard).filter(c => c.owner === p.id).length;
                p.score = owned;
            });

            const myOwned = newPlayers[myPlayerIndex].score;
            const domination = myOwned / totalHexes;

            room.updateRoomState({ board: newBoard, players: newPlayers });
            
            if (domination >= WIN_PCT) {
                endGame(myId);
                return;
            }

            const alivePlayers = newPlayers.filter(p => p.score > 0);
            if (alivePlayers.length === 1 && newPlayers.length > 1) {
                endGame(alivePlayers[0].id);
            }
        }
    };

    const endTurn = () => {
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (roomState.turnIndex !== myPlayerIndex) return;

        let nextIndex = (roomState.turnIndex + 1) % roomState.players.length;
        let newPlayers = [...roomState.players];

        // Skip eliminated players
        let attempts = 0;
        while (newPlayers[nextIndex].score === 0 && attempts < newPlayers.length) {
             nextIndex = (nextIndex + 1) % newPlayers.length;
             attempts++;
        }
        
        // Handle Global Turn Counter
        const currentTotalTurns = roomState.totalTurns || 0;
        const newTotalTurns = currentTotalTurns + 1;

        // Income for next player (Only after everyone has played once)
        if (roomState.totalTurns === undefined || newTotalTurns >= newPlayers.length) {
            const nextPlayerId = newPlayers[nextIndex].id;
            const territoryCount = Object.values(roomState.board).filter(c => c.owner === nextPlayerId).length;
            const income = 2 + Math.floor(territoryCount / 3);
            newPlayers[nextIndex].energy += income;
        }

        room.updateRoomState({
            turnIndex: nextIndex,
            players: newPlayers,
            totalTurns: newTotalTurns,
            turnStartTime: Date.now()
        });
    };

    const endGame = (winnerId) => {
        room.updateRoomState({ phase: 'gameover', winner: winnerId });
        playSound('victory');
        
        if (winnerId === myId) {
            updateStats(true, room.roomState.turnStartTime);
        } else {
            const wasPlayer = roomState.players.find(p => p.id === myId);
            if (wasPlayer) updateStats(false, room.roomState.turnStartTime);
        }
    };

    // --- RENDER ---

    const isMyTurn = status === 'playing' && roomState.players && roomState.players[roomState.turnIndex]?.id === myId;
    const myPlayer = roomState.players?.find(p => p.id === myId);

    const canAfford = (cost) => myPlayer && myPlayer.energy >= cost;

    const hexElements = [];
    if (roomState.board) {
        Object.values(roomState.board).forEach(hex => {
            const px = hexToPixel(hex);
            
            let colorClass = 'p0';
            if (hex.owner) {
                const ownerIdx = roomState.players.findIndex(p => p.id === hex.owner);
                if (ownerIdx >= 0) colorClass = `p${roomState.players[ownerIdx].colorIndex}`;
            }

            let opacity = 1;
            let stroke = null;
            let strokeWidth = null;
            let cursor = 'default';

            let isValidTarget = false;
            let classNames = `hex ${colorClass}`;

            if (hex.type === 'MOUNTAIN') {
                classNames += " mountain";
            }

            if (isMyTurn && action) {
                const neighbors = getNeighbors(hex);
                const hasFriendlyAdj = neighbors.some(n => {
                   const c = roomState.board[getKey(n)];
                   return c && c.owner === myId;
                });
                const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);
                
                // --- Validation Logic ---
                if (action === 'deploy') {
                     const isOccupied = hex.owner && roomState.players.some(p => p.id === hex.owner);
                     isValidTarget = !isOccupied && (hasFriendlyAdj || !hasAnyTile);
                } else if (action === 'fortify') {
                     isValidTarget = hex.owner === myId;
                } else if (action === 'overload') {
                     if (hex.owner && hex.owner !== myId) {
                         const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                            const nCell = roomState.board[getKey(n)];
                            if (nCell && nCell.owner === myId) return Math.max(maxStr, nCell.strength);
                            return maxStr;
                         }, 0);
                         isValidTarget = myStrongestAdj > hex.strength;
                     }
                }

                if (isValidTarget) {
                    classNames += " valid-target";
                    cursor = 'pointer';
                } else {
                    classNames += " invalid-target";
                    opacity = 0.3;
                }
            } else if (isMyTurn && !action && hex.owner === myId) {
                 // Hint that you can select this tile (maybe for info in future)
                 cursor = 'help';
            }

            // Height Effect (Shift Y)
            const yOffset = hex.type === 'MOUNTAIN' ? -6 : 0;
            const finalY = px.y + yOffset;

            // Height Shadow
            const shadow = hex.type === 'MOUNTAIN' ? (
                <polygon points="0,-24 26,-9 26,21 0,36 -26,21 -26,-9" fill="rgba(0,0,0,0.5)" transform="translate(0, 6)"/>
            ) : null;

            hexElements.push(
                <g key={getKey(hex)} 
                   transform={`translate(${px.x}, ${finalY})`}
                   onClick={() => handleHexClick(hex)}
                   className="hex-group"
                   style={{ cursor }}>
                    {shadow}
                    <polygon 
                        points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15" 
                        className={classNames}
                        style={{ opacity, stroke: stroke || undefined, strokeWidth: strokeWidth || undefined }}
                    />
                    {hex.item === 'energy' && !hex.owner && (
                         <image href="icon_energy.png" x="-10" y="-10" width="20" height="20" className="item-icon" />
                    )}
                    {hex.strength > 0 && (
                        <text x="0" y="5" textAnchor="middle" className="hex-label">{hex.strength}</text>
                    )}
                </g>
            );
        });
    }

    if (status === 'loading') return <div className="screen"><h1>Initializing...</h1></div>;

    if (status === 'lobby') {
        const isHost = Object.keys(peers)[0] === myId;
        return (
            <div className="screen">
                <h1 className="neon-text">Neon Nebula</h1>
                <div style={{ display: 'flex', gap: '40px', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <div className="modal">
                        <h2>Lobby</h2>
                        <ul className="player-list">
                            {Object.values(peers).map(p => (
                                <li key={p.id}>
                                    <div style={{display:'flex', alignItems:'center'}}>
                                        <img src={p.avatarUrl} className="avatar"/>
                                        {p.username}
                                    </div>
                                    {p.id === myId && <span style={{color:'var(--primary)'}}>(You)</span>}
                                </li>
                            ))}
                        </ul>
                        {isHost ? (
                            <div style={{display:'flex', flexDirection:'column', gap:'10px'}}>
                                <button className="btn" disabled={Object.keys(peers).length < 1} onClick={startGame}>Start Conquest</button>
                                {Object.keys(peers).length === 1 && <span style={{fontSize:'0.8rem', color:'#888'}}>AI Bots will be added</span>}
                            </div>
                        ) : <p>Waiting for host...</p>}
                    </div>
                    <div className="modal">
                        <h2>Leaderboard</h2>
                        <ul className="player-list">
                            {leaderboard.map((record, i) => (
                                <li key={record.id}>#{i+1} {record.username} ({record.col_1?.elo})</li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'gameover') {
        const winner = roomState.players.find(p => p.id === roomState.winner);
        return (
            <div className="screen">
                <div className="modal">
                    <h1>{roomState.winner === myId ? "VICTORY" : "DEFEAT"}</h1>
                    <p>Winner: {winner?.username}</p>
                    <button className="btn" onClick={() => room.updateRoomState({ phase: 'lobby' })}>Return</button>
                </div>
            </div>
        );
    }

    // Using a fixed viewBox centered at 0,0 to automatically scale the board
    // Board radius 4 * 30px ~ 120px + padding => 300px range
    return (
        <div className="screen">
            <div className="hud-top">
                <div style={{display:'flex', gap:'10px'}}>
                    {roomState.players.map(p => (
                        <div key={p.id} className={`turn-indicator ${roomState.players[roomState.turnIndex].id === p.id ? 'turn-active' : ''}`}
                             style={{ color: p.score === 0 ? '#555' : (p.colorIndex === 1 ? '#00f0ff' : p.colorIndex === 2 ? '#ff0055' : p.colorIndex === 3 ? '#ccff00' : '#bd00ff') }}>
                            {p.username} ({p.score})
                        </div>
                    ))}
                </div>
                <div>{myPlayer && <div style={{ fontSize: '1.5rem', color: 'var(--accent)' }}>⚡ {myPlayer.energy}</div>}</div>
            </div>

            <div className="game-board-container">
                <svg className="hex-grid" viewBox="-500 -450 1000 900" preserveAspectRatio="xMidYMid meet">
                    {hexElements}
                </svg>
            </div>

            {isMyTurn ? (
                <div className="hud-bottom">
                    <div className={`action-card ${action === 'deploy' ? 'selected' : ''}`} onClick={() => setAction(action==='deploy'?null:'deploy')}
                         style={{opacity:canAfford(COSTS.DEPLOY)?1:0.5}}>
                        <img src="icon_energy.png"/><span>Deploy ({COSTS.DEPLOY})</span>
                    </div>
                    <div className={`action-card ${action === 'fortify' ? 'selected' : ''}`} onClick={() => setAction(action==='fortify'?null:'fortify')}
                         style={{opacity:canAfford(COSTS.FORTIFY)?1:0.5}}>
                        <img src="icon_shield.png"/><span>Fortify ({COSTS.FORTIFY})</span>
                    </div>
                    <div className={`action-card ${action === 'overload' ? 'selected' : ''}`} onClick={() => setAction(action==='overload'?null:'overload')}
                         style={{opacity:canAfford(COSTS.OVERLOAD)?1:0.5}}>
                        <img src="icon_attack.png"/><span>Overload ({COSTS.OVERLOAD})</span>
                    </div>
                    <button className="btn btn-secondary" onClick={endTurn} style={{marginLeft:'20px'}}>End Turn</button>
                </div>
            ) : (
                <div className="hud-bottom"><p>Waiting for {roomState.players[roomState.turnIndex]?.username}...</p></div>
            )}
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Game />);