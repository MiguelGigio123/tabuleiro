const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for no transparency on base layer

// UI Elements
const hud = document.getElementById('hud');
const startScreen = document.getElementById('start-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

const speedEl = document.getElementById('speed');
const gearEl = document.getElementById('gear');
const lapEl = document.getElementById('lap');
const timeEl = document.getElementById('time');
const bestTimeEl = document.getElementById('best-time');
const finalTimeEl = document.getElementById('final-time');
const finalBestEl = document.getElementById('final-best');

// Game State
let gameState = 'START'; // 'START', 'PLAYING', 'GAMEOVER'
let lastTime = 0;
let uiUpdateTimer = 0;

// Timing
let raceStartTime = 0;
let currentLapStartTime = 0;
let bestLapTime = Infinity;
let totalRaceTime = 0;
let currentLap = 1;
const totalLaps = 3;

// Input State
const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false, " ": false };

// Car Physics Object
const car = {
    x: 0, y: 0,
    vx: 0, vy: 0,
    angle: -Math.PI/2, // point "up" initially
    speed: 0,
    width: 20,
    length: 44,
    accel: 0.15,
    brakeForce: 0.3,
    maxGripDownforce: 0.98, // Multiplier for friction/grip tracking
    friction: 0.985,       // Air drag / rolling resistance
    grassFriction: 0.93,   // Slow down on grass
    turnSpeed: 0.045
};

// Track and Camera Setup
const trackWidth = 250;
let rawTrackPoints = [
    {x: 0, y: 1000},       // Start/Finish straight (bottom)
    {x: 1800, y: 1000},    // Turn 1
    {x: 2200, y: -200},    // Turn 2
    {x: 1500, y: -1500},   // Sweeper left
    {x: -500, y: -1800},   // Back straight
    {x: -1800, y: -800},   // Esses
    {x: -1500, y: 500},    // Fast corner
    {x: -500, y: 1000}     // Return to start
];

// Track generation
let trackPath = [];
let trackLength = 0;
let finishLine = {};

// Skidmarks / Particle system
const particles = [];
const skidmarks = [];

// Resize handler
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Input listeners
window.addEventListener('keydown', (e) => {
    if (keys.hasOwnProperty(e.key)) keys[e.key] = true;
});
window.addEventListener('keyup', (e) => {
    if (keys.hasOwnProperty(e.key)) keys[e.key] = false;
});

// Utility: Chaikin's Corner Cutting Algorithm to smooth track
function generateSmoothTrack(pts, iterations) {
    if (iterations === 0) return pts;
    let newPts = [];
    for (let i = 0; i < pts.length; i++) {
        let p0 = pts[i];
        let p1 = pts[(i + 1) % pts.length];
        newPts.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
        newPts.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    return generateSmoothTrack(newPts, iterations - 1);
}

// Math util: distance from point to line segment
function distToSegment(p, v, w) {
    let l2 = (w.x - v.x) * (w.x - v.x) + (w.y - v.y) * (w.y - v.y);
    if (l2 === 0) return Math.sqrt((p.x - v.x) * (p.x - v.x) + (p.y - v.y) * (p.y - v.y));
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt(
        (p.x - (v.x + t * (w.x - v.x))) * (p.x - (v.x + t * (w.x - v.x))) +
        (p.y - (v.y + t * (w.y - v.y))) * (p.y - (v.y + t * (w.y - v.y)))
    );
}

function getTrackInfo(point) {
    let minDist = Infinity;
    let closestIndex = 0;
    for (let i = 0; i < trackPath.length; i++) {
        let d = distToSegment(point, trackPath[i], trackPath[(i + 1) % trackPath.length]);
        if (d < minDist) {
            minDist = d;
            closestIndex = i;
        }
    }
    return { dist: minDist, checkpoint: closestIndex };
}

function initGame() {
    trackPath = generateSmoothTrack(rawTrackPoints, 4);
    
    // Position car at start line
    car.x = trackPath[0].x;
    car.y = trackPath[0].y;
    
    // Orient car towards point 1
    car.angle = Math.atan2(trackPath[1].y - trackPath[0].y, trackPath[1].x - trackPath[0].x);
    car.vx = 0;
    car.vy = 0;
    car.speed = 0;

    finishLine = {
        p1: trackPath[trackPath.length -1],
        p2: trackPath[0]
    };

    currentLap = 1;
    raceStartTime = performance.now();
    currentLapStartTime = performance.now();
    bestLapTime = Infinity;
    skidmarks.length = 0;
    
    hud.classList.remove('hidden');
    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    
    gameState = 'PLAYING';
    
    requestAnimationFrame(gameLoop);
}

// Checkpoint logic to prevent cheating
let highestCheckpoint = 0;
let lastCheckpoint = 0;
const totalCheckpoints = 16 * 4; // Because iterations=4 means 16x points. Wait, trackPath length.

function updatePhysics(dt) {
    if (gameState !== 'PLAYING') return;

    // Input mapped to forces
    let forward = (keys.w || keys.ArrowUp) ? 1 : 0;
    let backward = (keys.s || keys.ArrowDown) ? 1 : 0;
    let left = (keys.a || keys.ArrowLeft) ? 1 : 0;
    let right = (keys.d || keys.ArrowRight) ? 1 : 0;
    let driftBtn = keys[" "];

    // Engine acceleration
    let engineForce = 0;
    if (forward) engineForce = car.accel;
    if (backward) engineForce = -car.brakeForce;

    // Steering (can only turn if moving, tighter turning at lower speeds feels better, but keep it simple)
    if (car.speed > 0.5) {
        let turnDir = right - left;
        // Decrease turn speed slightly at very high speeds for stability
        let speedFactor = Math.max(0.5, 1 - (car.speed / 40)); 
        car.angle += turnDir * car.turnSpeed * speedFactor * Math.sign(car.speed);
    }

    // Apply engine force to heading vector
    let forwardVx = Math.cos(car.angle);
    let forwardVy = Math.sin(car.angle);
    
    car.vx += forwardVx * engineForce;
    car.vy += forwardVy * engineForce;

    // Track state (On asphalt vs Grass)
    let trackInfo = getTrackInfo(car);
    let onGrass = trackInfo.dist > trackWidth / 2;
    
    let currentFriction = onGrass ? car.grassFriction : car.friction;
    
    // Apply rolling resistance / drag
    car.vx *= currentFriction;
    car.vy *= currentFriction;

    // Drifting physics (Sliding)
    let vAngle = Math.atan2(car.vy, car.vx);
    let vMag = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    car.speed = vMag; // Update total speed scalar

    if (vMag > 0.1) {
        let angleDiff = car.angle - vAngle;
        while (angleDiff <= -Math.PI) angleDiff += Math.PI * 2;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

        let grip = 0.15; // Natural grip recovering
        let isSliding = Math.abs(angleDiff) > 0.3; // Angle Difference Threshold

        if (driftBtn && vMag > 5) {
            grip = 0.03; // Handbrake reduces grip significantly
            isSliding = true;
        }
        if (onGrass) grip = 0.05;

        // Apply grip: rotate velocity vector towards heading
        let targetVAngle = vAngle + angleDiff * grip;
        car.vx = Math.cos(targetVAngle) * vMag;
        car.vy = Math.sin(targetVAngle) * vMag;

        // Particles & Skidmarks
        if (isSliding && vMag > 4 && !onGrass) {
            // Wheels config: back and front relative to car center
            let fl = { x: car.x + Math.cos(car.angle)*15 + Math.sin(car.angle)*10, y: car.y + Math.sin(car.angle)*15 - Math.cos(car.angle)*10 };
            let fr = { x: car.x + Math.cos(car.angle)*15 - Math.sin(car.angle)*10, y: car.y + Math.sin(car.angle)*15 + Math.cos(car.angle)*10 };
            let rl = { x: car.x - Math.cos(car.angle)*15 + Math.sin(car.angle)*10, y: car.y - Math.sin(car.angle)*15 - Math.cos(car.angle)*10 };
            let rr = { x: car.x - Math.cos(car.angle)*15 - Math.sin(car.angle)*10, y: car.y - Math.sin(car.angle)*15 + Math.cos(car.angle)*10 };
            
            skidmarks.push({x: rl.x, y: rl.y, a: 0.2});
            skidmarks.push({x: rr.x, y: rr.y, a: 0.2});
            
            if (Math.random() > 0.5) {
                particles.push({
                    x: rl.x + (Math.random()-0.5)*5, y: rl.y + (Math.random()-0.5)*5,
                    vx: -car.vx * 0.2, vy: -car.vy * 0.2,
                    life: 1.0, size: Math.random()*10 + 5
                });
            }
        }
    }

    // Limit skidmarks array size
    if (skidmarks.length > 500) skidmarks.splice(0, 10);

    // Update position
    car.x += car.vx;
    car.y += car.vy;

    // Update particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= 0.05;
        if (p.life <= 0) particles.splice(i, 1);
    }

    // Lap logic
    let cp = trackInfo.checkpoint;
    let nPts = trackPath.length;
    
    // Valid checkpoint progression
    if (cp > highestCheckpoint && cp <= highestCheckpoint + Math.floor(nPts/4)) {
        highestCheckpoint = cp;
    }
    
    // Cross finish line
    if (lastCheckpoint > nPts * 0.9 && cp < nPts * 0.1 && highestCheckpoint > nPts * 0.5) {
        completeLap();
    }
    lastCheckpoint = cp;
}

function completeLap() {
    let now = performance.now();
    let lapTime = now - currentLapStartTime;
    
    if (lapTime < bestLapTime) {
        bestLapTime = lapTime;
    }
    
    currentLap++;
    currentLapStartTime = now;
    highestCheckpoint = 0; // reset for new lap

    if (currentLap > totalLaps) {
        endRace();
    }
}

function formatTime(ms) {
    if (ms === Infinity) return "--:--.--";
    let date = new Date(ms);
    let m = date.getMinutes().toString().padStart(2, '0');
    let s = date.getSeconds().toString().padStart(2, '0');
    let msStr = Math.floor(date.getMilliseconds() / 10).toString().padStart(2, '0');
    return `${m}:${s}.${msStr}`;
}

function updateHUD(now) {
    // Throttled UI updates for performance
    if (now - uiUpdateTimer > 50) {
        speedEl.innerText = Math.round(car.speed * 15); // Scale speed for visuals
        
        let gear = 'N';
        if (car.speed > 0.5) {
            let s = car.speed * 15;
            if (s < 50) gear = '1';
            else if (s < 100) gear = '2';
            else if (s < 150) gear = '3';
            else if (s < 220) gear = '4';
            else if (s < 280) gear = '5';
            else gear = '6';
        } else if (keys.s || keys.ArrowDown && car.speed < 1) {
            gear = 'R';
            speedEl.innerText = Math.round(Math.abs(car.vx*15 + car.vy*15)); // reverse speed hack
        }
        gearEl.innerText = gear;
        
        lapEl.innerText = `${Math.min(currentLap, totalLaps)}/${totalLaps}`;
        bestTimeEl.innerText = formatTime(bestLapTime);
        timeEl.innerText = formatTime(now - currentLapStartTime);
        
        uiUpdateTimer = now;
    }
}

function drawTrack(ctx) {
    // Background Ground
    ctx.fillStyle = '#0f171e';
    ctx.fillRect(-10000, -10000, 20000, 20000);

    // Track base
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Draw Kerbs (Slightly wider than track)
    ctx.lineWidth = trackWidth + 20;
    ctx.beginPath();
    ctx.moveTo(trackPath[0].x, trackPath[0].y);
    for (let i = 1; i < trackPath.length; i++) {
        ctx.lineTo(trackPath[i].x, trackPath[i].y);
    }
    ctx.closePath();
    
    // Kerb dashed pattern outline
    ctx.setLineDash([40, 40]);
    ctx.strokeStyle = '#ff2a2a'; // Red
    ctx.stroke();
    
    ctx.lineDashOffset = 40;
    ctx.strokeStyle = '#ffffff'; // White
    ctx.stroke();
    ctx.setLineDash([]); // Reset
    
    // Draw Asphalt
    ctx.lineWidth = trackWidth;
    ctx.strokeStyle = '#2a2c32';
    ctx.stroke();

    // Start/Finish Line Checkerboard
    let p1 = trackPath[0];
    let p2 = trackPath[1];
    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    
    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(angle);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-10, -trackWidth/2, 20, trackWidth);
    
    // Checkers
    ctx.fillStyle = '#000';
    let squareSize = 25;
    for(let i=0; i<trackWidth/squareSize; i++){
        // row 1
        if(i%2==0) ctx.fillRect(-10, -trackWidth/2 + i*squareSize, 10, squareSize);
        // row 2
        if(i%2==1) ctx.fillRect(0, -trackWidth/2 + i*squareSize, 10, squareSize);
    }
    ctx.restore();

    // Skidmarks
    ctx.fillStyle = 'rgba(10, 10, 10, 0.4)';
    for(let i=0; i<skidmarks.length; i++) {
        let sm = skidmarks[i];
        ctx.beginPath();
        ctx.arc(sm.x, sm.y, 4, 0, Math.PI*2);
        ctx.fill();
    }
}

function drawCar(ctx) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    // Particles (Smoke / dust behind car)
    // Actually drawn in world space to leave trails
    
    // Car Body / Geometry
    
    // Tires
    ctx.fillStyle = '#111';
    let tireW = 8;
    let tireH = 16;
    let axOff = car.length / 2 - 8;
    let latOff = car.width / 2 + 3;
    
    // Wheels (Static relative to car body rotation)
    ctx.fillRect(axOff, -latOff - tireW/2, tireH, tireW); // FL
    ctx.fillRect(axOff, latOff - tireW/2, tireH, tireW);  // FR
    ctx.fillRect(-axOff, -latOff - tireW/2, tireH, tireW); // RL
    ctx.fillRect(-axOff, latOff - tireW/2, tireH, tireW);  // RR
    
    // Axles
    ctx.fillStyle = '#333';
    ctx.fillRect(axOff, -latOff, 2, latOff*2);
    ctx.fillRect(-axOff, -latOff, 2, latOff*2);

    // Main Body
    ctx.fillStyle = '#ff2a2a'; // Neon Red
    
    // Nose cone
    ctx.beginPath();
    ctx.moveTo(car.length/2 + 10, 0);
    ctx.lineTo(car.length/2, -car.width/3);
    ctx.lineTo(-car.length/2 + 5, -car.width/2);
    ctx.lineTo(-car.length/2 + 5, car.width/2);
    ctx.lineTo(car.length/2, car.width/3);
    ctx.fill();

    // Front Wing
    ctx.fillStyle = '#111';
    ctx.fillRect(car.length/2 + 5, -car.width/2 - 5, 5, car.width + 10);
    ctx.fillStyle = '#ff2a2a'; // Accents
    ctx.fillRect(car.length/2 + 5, -car.width/2 - 5, 5, 3);
    ctx.fillRect(car.length/2 + 5, car.width/2 + 2, 5, 3);

    // Cockpit
    ctx.fillStyle = '#050505';
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI*2);
    ctx.fill();
    
    // Driver helmet
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-2, 0, 4, 0, Math.PI*2);
    ctx.fill();

    // Rear Wing
    ctx.fillStyle = '#111';
    ctx.fillRect(-car.length/2 - 5, -car.width/2 - 8, 8, car.width + 16);
    ctx.fillStyle = '#ff2a2a'; 
    ctx.fillRect(-car.length/2 - 5, -car.width/2 - 8, 2, car.width + 16);

    ctx.restore();
}

function drawWorldParticles(ctx) {
    for (let p of particles) {
        // Smoke
        ctx.fillStyle = `rgba(200, 200, 200, ${p.life * 0.3})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
        ctx.fill();
    }
}

function endRace() {
    gameState = 'GAMEOVER';
    
    totalRaceTime = performance.now() - raceStartTime;
    
    finalTimeEl.innerText = formatTime(totalRaceTime);
    finalBestEl.innerText = formatTime(bestLapTime);
    
    gameOverScreen.classList.remove('hidden');
    hud.classList.add('hidden');
}

function gameLoop(now) {
    if (gameState !== 'PLAYING') return;

    // Fixed dt could be used for deterministic physics, but simplify using scaled frame diff
    let dt = now - lastTime;
    lastTime = now;

    // Simulate physics
    updatePhysics(dt);

    // Camera strictly follows car
    let cx = car.x;
    let cy = car.y;

    // Render
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear screen completely

    ctx.save();
    // Move to center of screen, then translate by camera position
    ctx.translate(canvas.width / 2, canvas.height / 2);
    
    // Optional: Rotating camera makes it completely driver pov, but top-down is easier to play.
    // To rotate camera: ctx.rotate(-car.angle - Math.PI/2);
    
    ctx.translate(-cx, -cy);

    // Draw world elements
    drawTrack(ctx);
    drawWorldParticles(ctx);
    drawCar(ctx);

    ctx.restore();

    // HUD Update
    updateHUD(now);

    requestAnimationFrame(gameLoop);
}

// Initial draw for background before start
function initialRender() {
    trackPath = generateSmoothTrack(rawTrackPoints, 4);
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    // Center camera on start line initially
    let cx = trackPath[0].x;
    let cy = trackPath[0].y;
    ctx.translate(canvas.width / 2 - cx, canvas.height / 2 - cy);
    
    drawTrack(ctx);
    
    // Draw car
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(trackPath[1].y - trackPath[0].y, trackPath[1].x - trackPath[0].x));
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(-22, -10, 44, 20); // Placeholder just for start screen to look like a red car
    ctx.restore();

    ctx.restore();
}
initialRender();

startBtn.addEventListener('click', () => {
    initGame();
});

restartBtn.addEventListener('click', () => {
    initGame();
});
