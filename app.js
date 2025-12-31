import { getHexGrid, hexToPixel, getKey, getNeighbors, hexDistance } from './hex_engine.js';

// --- CONFIG ---
const MAX_PLAYERS = 4;
const BOARD_RADIUS = 4;
const STARTING_ENERGY = 3;
const WINNING_SCORE = 20; // Or standard turn limit
const COSTS = {
    DEPLOY: 2,
    FORTIFY: 1,
    OVERLOAD: 3
};

// --- AUDIO ---
const sfx = {
    deploy: new Audio('sfx_deploy.mp3'),
    overload: new Audio('sfx_overload.mp3'),
    victory: new Audio('sfx_victory.mp3')
};
const playSound = (name) => {
    sfx[name].currentTime = 0;
    sfx[name].play().catch(e => {}); // Ignore interaction errors
};

// --- DB HELPERS ---
// Using columns 1 and 2 of a record per user as requested by prompt constraints.
// We will use a collection named 'user_data_v1' where the owner is the user.
async function getUserData() {
    try {
        const currentUser = await window.websim.getCurrentUser();
        // Filter by owner = current user. 
        // Note: Websim filter usually works on fields, not metadata like 'owner'. 
        // We will create a record with 'username' field to query.
        const records = await room.collection('user_data_v1').filter({ username: currentUser.username }).getList();
        
        if (records.length === 0) {
            // Initialize new user row
            return await room.collection('user_data_v1').create({
                username: currentUser.username,
                col_1: { wins: 0, losses: 0, matches_played: 0, elo: 1000 }, // Stats
                col_2: { history: [] } // Match Log
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
    // Keep history short
    if (history.length > 10) history.pop();

    await room.collection('user_data_v1').update(record.id, {
        col_1: stats,
        col_2: { history }
    });
}

// --- WEBSIM SETUP ---
const room = new WebsimSocket();

function Game() {
    const [status, setStatus] = React.useState('loading'); // loading, lobby, playing, gameover
    const [peers, setPeers] = React.useState({});
    const [roomState, setRoomState] = React.useState({});
    const [presence, setPresence] = React.useState({});
    const [myId, setMyId] = React.useState(null);
    const [action, setAction] = React.useState(null); // 'deploy', 'fortify', 'overload'
    const [hoverHex, setHoverHex] = React.useState(null);
    const [userStats, setUserStats] = React.useState(null);
    const [leaderboard, setLeaderboard] = React.useState([]);

    React.useEffect(() => {
        const init = async () => {
            await room.initialize();
            setPeers(room.peers);
            setRoomState(room.roomState);
            setPresence(room.presence);
            setMyId(room.clientId);
            
            room.subscribePeers(setPeers);
            room.subscribeRoomState(setRoomState);
            room.subscribePresence(setPresence);

            // Fetch user stats
            const stats = await getUserData();
            setUserStats(stats?.col_1);

            // Initial Room State Setup if empty
            if (!room.roomState.phase) {
                // Only first connector sets this up mostly, but updateRoomState merges so it's safe
                room.updateRoomState({
                    phase: 'lobby',
                    players: [], // { id, color, energy, score }
                    board: {}, // Keyed by "q,r" -> { owner: null/id, strength: 0 }
                    turnIndex: 0,
                    turnStartTime: Date.now()
                });
            }

            setStatus(room.roomState.phase || 'lobby');
            
            // Fetch global leaderboard (all user_data records)
            // Note: In a real app we'd want server-side aggregation, but here we scan recent active users
            const allStats = await room.collection('user_data_v1').getList();
            const sorted = allStats.sort((a,b) => (b.col_1?.elo || 0) - (a.col_1?.elo || 0)).slice(0, 10);
            setLeaderboard(sorted);
        };
        init();
    }, []);

    // Sync local status with room phase
    React.useEffect(() => {
        if (roomState.phase) {
            setStatus(roomState.phase);
        }
    }, [roomState.phase]);

    // --- GAME LOGIC ---

    const startGame = () => {
        const playerIds = Object.keys(peers);
        if (playerIds.length < 1) return; // Allow 1 for testing, normally 2+

        // Initialize Board
        const grid = getHexGrid(BOARD_RADIUS);
        const board = {};
        grid.forEach(hex => {
            board[getKey(hex)] = { ...hex, owner: null, strength: 0 };
        });

        // Initialize Players
        const players = playerIds.map((id, index) => ({
            id: id,
            colorIndex: index + 1, // 1-4
            energy: STARTING_ENERGY,
            score: 0,
            username: peers[id].username
        }));

        // Assign Start Positions (Corners)
        // Hardcoded start positions for 4-radius hex grid
        const starts = [
            {q: 0, r: 0}, // Center (for 1 player test) or
            {q: 0, r: -4}, {q: 0, r: 4}, // Top/Bottom
            {q: -4, r: 0}, {q: 4, r: 0}  // Sides
        ]; 
        
        // Better spread for N players
        const actualStarts = [];
        if (players.length === 1) actualStarts.push({q:0, r:0});
        else if (players.length === 2) { actualStarts.push({q:0, r:-4}, {q:0, r:4}); }
        else {
             // Just pick random edge hexes for 3+
             actualStarts.push({q:0, r:-4}, {q:4, r:-4}, {q:4, r:0}, {q:0, r:4}, {q:-4, r:4}, {q:-4, r:0});
        }

        players.forEach((p, i) => {
            if (i < actualStarts.length) {
                const hexKey = getKey(actualStarts[i]);
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
            turnStartTime: Date.now(),
            logs: []
        });
        
        playSound('deploy');
    };

    const handleHexClick = (hex) => {
        if (status !== 'playing') return;
        
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (myPlayerIndex === -1) return; // Spectator
        if (roomState.turnIndex !== myPlayerIndex) return; // Not my turn

        const me = roomState.players[myPlayerIndex];
        const key = getKey(hex);
        const cell = roomState.board[key];
        
        if (!cell) return;

        let newBoard = { ...roomState.board };
        let newPlayers = [...roomState.players];
        let currentPlayer = { ...newPlayers[myPlayerIndex] };
        let actionSuccess = false;

        // --- ACTION LOGIC ---
        
        if (action === 'deploy') {
            // Rule: Must be empty, must be adjacent to own tile (or you have 0 tiles)
            // Cost: 2
            if (currentPlayer.energy >= COSTS.DEPLOY && cell.owner === null) {
                // Check adjacency
                const neighbors = getNeighbors(hex);
                const hasNeighbor = neighbors.some(n => {
                    const nKey = getKey(n);
                    return roomState.board[nKey] && roomState.board[nKey].owner === myId;
                });
                
                // Allow if adjacent OR if player has no tiles left on board (wiped out recovery)
                const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);

                if (hasNeighbor || !hasAnyTile) {
                    newBoard[key] = { ...cell, owner: myId, strength: 1 };
                    currentPlayer.energy -= COSTS.DEPLOY;
                    actionSuccess = true;
                    playSound('deploy');
                }
            }
        } else if (action === 'fortify') {
            // Rule: Must own tile. Max strength 5?
            // Cost: 1
            if (currentPlayer.energy >= COSTS.FORTIFY && cell.owner === myId) {
                newBoard[key] = { ...cell, strength: cell.strength + 1 };
                currentPlayer.energy -= COSTS.FORTIFY;
                actionSuccess = true;
                playSound('deploy');
            }
        } else if (action === 'overload') {
            // Rule: Must be enemy tile. Must be adjacent to own tile. own tile strength > enemy.
            // Cost: 3
            if (currentPlayer.energy >= COSTS.OVERLOAD && cell.owner !== null && cell.owner !== myId) {
                const neighbors = getNeighbors(hex);
                // Find strongest adjacent friendly
                const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                    const nKey = getKey(n);
                    const nCell = roomState.board[nKey];
                    if (nCell && nCell.owner === myId) {
                        return Math.max(maxStr, nCell.strength);
                    }
                    return maxStr;
                }, 0);

                if (myStrongestAdj > cell.strength) {
                    // Success!
                    newBoard[key] = { ...cell, owner: myId, strength: Math.max(1, cell.strength - 1) };
                    currentPlayer.energy -= COSTS.OVERLOAD;
                    actionSuccess = true;
                    playSound('overload');
                }
            }
        }

        if (actionSuccess) {
            newPlayers[myPlayerIndex] = currentPlayer;
            
            // Recalculate Scores
            newPlayers.forEach(p => {
                p.score = Object.values(newBoard).filter(c => c.owner === p.id).length;
            });

            room.updateRoomState({
                board: newBoard,
                players: newPlayers
            });
            
            // Win Condition Check (Total domination)
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

        // Give energy to NEXT player based on their territory
        const nextPlayerId = newPlayers[nextIndex].id;
        const territoryCount = Object.values(roomState.board).filter(c => c.owner === nextPlayerId).length;
        
        // Income Logic: Base 2 + 1 per 3 tiles
        const income = 2 + Math.floor(territoryCount / 3);
        newPlayers[nextIndex].energy += income;

        room.updateRoomState({
            turnIndex: nextIndex,
            players: newPlayers,
            turnStartTime: Date.now()
        });
    };

    const endGame = (winnerId) => {
        room.updateRoomState({ phase: 'gameover', winner: winnerId });
        playSound('victory');
        
        // Update Stats
        if (winnerId === myId) {
            updateStats(true, room.roomState.turnStartTime); // using timestamp as rough ID
        } else {
            // Find if I was a player
            const wasPlayer = roomState.players.find(p => p.id === myId);
            if (wasPlayer) updateStats(false, room.roomState.turnStartTime);
        }
    };

    // --- RENDER HELPERS ---

    const isMyTurn = status === 'playing' && roomState.players && roomState.players[roomState.turnIndex]?.id === myId;
    const myPlayer = roomState.players?.find(p => p.id === myId);

    // Board Rendering
    const hexElements = [];
    if (roomState.board) {
        Object.values(roomState.board).forEach(hex => {
            const px = hexToPixel(hex);
            const isOwner = hex.owner === myId;
            const isEnemy = hex.owner && hex.owner !== myId;
            
            let colorClass = 'p0';
            if (hex.owner) {
                const ownerIdx = roomState.players.findIndex(p => p.id === hex.owner);
                if (ownerIdx >= 0) colorClass = `p${roomState.players[ownerIdx].colorIndex}`;
            }

            // Highlighting based on action
            let opacity = 1;
            let stroke = null;
            
            if (isMyTurn && action) {
                const neighbors = getNeighbors(hex);
                const hasFriendlyAdj = neighbors.some(n => {
                   const c = roomState.board[getKey(n)];
                   return c && c.owner === myId;
                });

                if (action === 'deploy') {
                    // Highlight empty adjacent
                    if (hex.owner === null && hasFriendlyAdj) stroke = 'white';
                    else opacity = 0.3;
                } else if (action === 'fortify') {
                    if (hex.owner === myId) stroke = 'white';
                    else opacity = 0.3;
                } else if (action === 'overload') {
                    if (isEnemy && hasFriendlyAdj) stroke = 'red';
                    else opacity = 0.3;
                }
            }
            
            // Hover effect from other players?
            // Could iterate room.presence to show rings around hexes

            hexElements.push(
                <g key={getKey(hex)} 
                   transform={`translate(${px.x + window.innerWidth/2}, ${px.y + window.innerHeight/2})`}
                   onClick={() => handleHexClick(hex)}
                   className="hex-group">
                    <polygon 
                        points="-30,-15 -15,-30 15,-30 30,-15 30,15 15,30 -15,30 -30,15" // Approx hex
                        className={`hex ${colorClass}`}
                        style={{ opacity, stroke: stroke || undefined }}
                    />
                    {hex.strength > 0 && (
                        <text x="0" y="5" textAnchor="middle" className="hex-label">{hex.strength}</text>
                    )}
                </g>
            );
        });
    }

    // --- UI STATES ---

    if (status === 'loading') return <div className="screen"><h1>Initializing Nebula...</h1></div>;

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
                        {Object.keys(peers).length < 2 && <p style={{color:'#666'}}>Waiting for opponent...</p>}
                        {isHost ? (
                            <button className="btn" disabled={Object.keys(peers).length < 1} onClick={startGame}>
                                Start Conquest
                            </button>
                        ) : (
                            <p>Waiting for host to start...</p>
                        )}
                    </div>

                    <div className="modal">
                        <h2>Leaderboard</h2>
                        <ul className="player-list">
                            {leaderboard.map((record, i) => (
                                <li key={record.id}>
                                    <span>#{i+1} {record.username}</span>
                                    <span style={{color:'var(--accent)'}}>{record.col_1?.elo || 1000} ELO</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'gameover') {
        const winner = roomState.players.find(p => p.id === roomState.winner);
        const isMe = roomState.winner === myId;
        return (
            <div className="screen">
                <div className="modal">
                    <h1 className="neon-text">{isMe ? "VICTORY" : "DEFEAT"}</h1>
                    <p>Winner: {winner?.username}</p>
                    <div style={{margin: '20px 0'}}>
                        <p>Your Stats Updated:</p>
                        <div className="stat-row"><span>Wins:</span> <span>{userStats?.wins}</span></div>
                        <div className="stat-row"><span>Losses:</span> <span>{userStats?.losses}</span></div>
                        <div className="stat-row"><span>ELO:</span> <span>{userStats?.elo}</span></div>
                    </div>
                    <button className="btn" onClick={() => room.updateRoomState({ phase: 'lobby' })}>Return to Lobby</button>
                </div>
            </div>
        );
    }

    // Playing State
    return (
        <div className="screen">
            {/* HUD Top */}
            <div className="hud-top">
                <div style={{display:'flex', gap:'10px'}}>
                    {roomState.players.map(p => (
                        <div key={p.id} className={`turn-indicator ${roomState.players[roomState.turnIndex].id === p.id ? 'turn-active' : ''}`}
                             style={{ color: p.colorIndex === 1 ? '#00f0ff' : p.colorIndex === 2 ? '#ff0055' : p.colorIndex === 3 ? '#ccff00' : '#bd00ff' }}>
                            {p.username} 
                            <br/><small>Score: {p.score}</small>
                        </div>
                    ))}
                </div>
                <div>
                   {myPlayer && <div style={{ fontSize: '1.5rem', color: 'var(--accent)' }}>⚡ {myPlayer.energy} Energy</div>}
                </div>
            </div>

            {/* Board */}
            <div className="game-board-container">
                <svg className="hex-grid" viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}>
                    {hexElements}
                </svg>
            </div>

            {/* HUD Bottom (Controls) */}
            {isMyTurn ? (
                <div className="hud-bottom">
                    <div className={`action-card ${action === 'deploy' ? 'selected' : ''}`}
                         onClick={() => setAction('deploy')}>
                        <img src="icon_energy.png" alt="Deploy" />
                        <span>Deploy</span>
                        <span className="cost-badge">-{COSTS.DEPLOY} NRG</span>
                    </div>
                    <div className={`action-card ${action === 'fortify' ? 'selected' : ''}`}
                         onClick={() => setAction('fortify')}>
                        <img src="icon_shield.png" alt="Fortify" />
                        <span>Fortify</span>
                        <span className="cost-badge">-{COSTS.FORTIFY} NRG</span>
                    </div>
                    <div className={`action-card ${action === 'overload' ? 'selected' : ''}`}
                         onClick={() => setAction('overload')}>
                        <img src="icon_attack.png" alt="Overload" />
                        <span>Overload</span>
                        <span className="cost-badge">-{COSTS.OVERLOAD} NRG</span>
                    </div>
                    <button className="btn btn-secondary" onClick={endTurn} style={{marginLeft:'20px'}}>
                        End Turn
                    </button>
                </div>
            ) : (
                <div className="hud-bottom">
                    <p style={{background:'rgba(0,0,0,0.8)', padding:'10px', borderRadius:'4px'}}>
                        Waiting for {roomState.players[roomState.turnIndex]?.username}...
                    </p>
                </div>
            )}
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Game />);