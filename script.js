document.addEventListener('DOMContentLoaded', () => {
    // --- Canvas & Context Setup ---
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const socket = io();

    // --- State Management ---
    let state = {
        tool: 'pen',
        color: '#000000',
        brushSize: 5,
        eraserSize: 20,
        drawing: false,
        scale: 1,
        history: [],
        redoStack: [],
        pan: { x: 0, y: 0, active: false, startX: 0, startY: 0 },
        currentShape: null,
        isTyping: false
    };

    // --- UI Elements ---
    const ui = {
        colorPicker: document.getElementById('colorPicker'),
        brushSizeSlider: document.getElementById('size-slider'),
        eraserSizeSlider: document.getElementById('eraserSize'),
        userList: document.getElementById('userList'),
        chatMessages: document.getElementById('chatMessages'),
        chatForm: document.getElementById('chatForm'),
        chatInput: document.getElementById('chatInput'),
        sessionIdDisplay: document.getElementById('sessionIdDisplay'),
        sessionLink: document.getElementById('sessionLink'),
        imageUpload: document.getElementById('imageUpload')
    };

    // --- User & Session Info ---
    const username = localStorage.getItem("username") || "Guest";
    const sessionId = window.location.hash.slice(1) || `session-${Date.now().toString(36)}`;
    window.location.hash = sessionId;

    // --- Event Listener Setup ---
    function setupEventListeners() {
        // Mouse Events (for Desktop)
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseUp);

        // *** START: BUG FIX FOR MOBILE SUPPORT ***
        // Touch Events (for Mobile/Tablets)
        canvas.addEventListener('touchstart', onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', onTouchMove, { passive: false });
        canvas.addEventListener('touchend', onTouchEnd);
        canvas.addEventListener('touchcancel', onTouchEnd); // Handle interruptions
        // *** END: BUG FIX FOR MOBILE SUPPORT ***

        canvas.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('resize', resizeCanvas);

        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (state.isTyping) return;
                state.tool = btn.id;
                document.querySelector('.tool-btn.active')?.classList.remove('active');
                btn.classList.add('active');
                canvas.style.cursor = state.tool === 'text' ? 'text' : 'crosshair';
            });
        });

        ui.colorPicker.addEventListener('input', e => state.color = e.target.value);
        ui.brushSizeSlider.addEventListener('input', e => state.brushSize = e.target.value);
        ui.eraserSizeSlider.addEventListener('input', e => state.eraserSize = e.target.value);

        document.getElementById('clear').addEventListener('click', () => socket.emit('clear-board'));
        document.getElementById('save').addEventListener('click', downloadCanvas);
        document.getElementById('uploadImageBtn').addEventListener('click', () => ui.imageUpload.click());
        ui.imageUpload.addEventListener('change', handleImageUpload);

        document.getElementById('zoomIn').addEventListener('click', () => zoom(1.2));
        document.getElementById('zoomOut').addEventListener('click', () => zoom(1 / 1.2));

        document.getElementById('lightTheme').addEventListener('click', () => {
            document.body.className = 'light';
            redrawCanvas(); // Redraw canvas to apply color changes
        });
        document.getElementById('darkTheme').addEventListener('click', () => {
            document.body.className = 'dark';
            redrawCanvas(); // Redraw canvas to apply color changes
        });
        document.getElementById('colorfulTheme').addEventListener('click', () => {
            document.body.className = 'colorful';
            redrawCanvas(); // Redraw canvas to apply color changes
        });

        ui.chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const msg = ui.chatInput.value.trim();
            if (msg) {
                socket.emit('chat-message', msg);
                ui.chatInput.value = '';
            }
        });
    }

    // --- Socket Handlers ---
    function setupSocketListeners() {
        socket.on('connect', () => socket.emit('join-session', { sessionId, username }));
        socket.on('drawing-history', (actions) => { state.history = actions; redrawCanvas(); });
        socket.on('drawing-action', (data) => { state.history.push(data); drawAction(data, ctx); });
        socket.on('board-cleared', () => { state.history = []; state.redoStack = []; redrawCanvas(); });
        socket.on('user-list-update', (users) => { ui.userList.innerHTML = users.map(user => `<li>${user}</li>`).join(''); });
        socket.on('chat-message', ({ user, message }) => {
            ui.chatMessages.innerHTML += `<div><strong>${user}:</strong> ${message}</div>`;
            ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
        });
    }

    // *** START: BUG FIX FOR MOBILE SUPPORT ***
    // --- Touch Event Handlers ---
    // These functions translate touch events into the format our existing mouse handlers expect.
    function onTouchStart(e) {
        e.preventDefault(); // Prevents page scrolling while drawing
        const touch = e.touches[0];
        const mouseEvent = normalizeTouchEvent(touch);
        onMouseDown(mouseEvent);
    }

    function onTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = normalizeTouchEvent(touch);
        onMouseMove(mouseEvent);
    }

    function onTouchEnd(e) {
        // We don't need to pass an event to onMouseUp as it doesn't use it
        onMouseUp();
    }

    // Helper to create a mouse-like event object from a touch object
    function normalizeTouchEvent(touch) {
        const rect = canvas.getBoundingClientRect();
        return {
            offsetX: touch.clientX - rect.left,
            offsetY: touch.clientY - rect.top,
            clientX: touch.clientX,
            clientY: touch.clientY,
            button: 0 // Simulate a left-click
        };
    }
    // *** END: BUG FIX FOR MOBILE SUPPORT ***


    // --- Drawing & Interaction Logic ---
    function getTransformedPoint(x, y) {
        return { x: (x - state.pan.x) / state.scale, y: (y - state.pan.y) / state.scale };
    }

    function onMouseDown(e) {
        if (state.isTyping) return;
        if (e.button === 1 || e.ctrlKey) {
            state.pan.active = true;
            state.pan.startX = e.clientX - state.pan.x;
            state.pan.startY = e.clientY - state.pan.y;
            return;
        }

        if (state.tool === 'text') {
            createTextInput(e.offsetX, e.offsetY);
            return;
        }

        state.drawing = true;
        const startPoint = getTransformedPoint(e.offsetX, e.offsetY);
        const size = state.tool === 'eraser' ? state.eraserSize : state.brushSize;
        const color = state.tool === 'eraser' ? getBackgroundColor() : state.color;

        state.currentShape = {
            tool: state.tool, color, size,
            startX: startPoint.x, startY: startPoint.y,
            endX: startPoint.x, endY: startPoint.y,
            path: [startPoint]
        };
    }

    function onMouseMove(e) {
        if (state.pan.active) {
            state.pan.x = e.clientX - state.pan.startX;
            state.pan.y = e.clientY - state.pan.startY;
            redrawCanvas();
            return;
        }
        if (!state.drawing) return;

        const currentPoint = getTransformedPoint(e.offsetX, e.offsetY);
        if (state.tool === 'pen' || state.tool === 'eraser') {
            state.currentShape.path.push(currentPoint);
        } else {
            state.currentShape.endX = currentPoint.x;
            state.currentShape.endY = currentPoint.y;
        }
        redrawCanvas();
    }

    function onMouseUp() {
        if (state.pan.active) { state.pan.active = false; return; }
        if (!state.drawing) return;

        state.drawing = false;
        if (state.currentShape) {
            socket.emit('drawing-action', state.currentShape);
            state.history.push(state.currentShape);
            state.currentShape = null;
            state.redoStack = [];
        }
    }

    function onWheel(e) {
        e.preventDefault();
        if (state.isTyping) return;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoom(factor, e.offsetX, e.offsetY);
    }

    // --- Draggable Text Box Feature (BUG FIX) ---
    function createTextInput(x, y) {
        if (state.isTyping) return;
        state.isTyping = true;

        const textContainer = document.createElement('div');
        textContainer.className = 'text-input-container';

        const textarea = document.createElement('textarea');

        textContainer.style.left = `${x}px`;
        textContainer.style.top = `${y}px`;
        textarea.style.color = state.color;
        textarea.style.fontSize = `${state.brushSize * 2}px`;
        textContainer.style.transform = `scale(${state.scale})`;
        textContainer.style.transformOrigin = 'top left';

        textContainer.appendChild(textarea);
        document.body.appendChild(textContainer);

        // ✅ THE BUG FIX: Using setTimeout ensures the element is fully rendered before we try to focus it.
        setTimeout(() => {
            textarea.focus();
        }, 0);

        const finalizeText = () => {
            if (!state.isTyping) return;
            const text = textarea.value.trim();
            if (text) {
                const point = getTransformedPoint(x, y);
                const action = {
                    tool: 'text', text, color: state.color,
                    fontSize: state.brushSize * 2,
                    x: point.x, y: point.y
                };
                socket.emit('drawing-action', action);
                state.history.push(action);
                drawAction(action, ctx);
            }
            document.body.removeChild(textContainer);
            state.isTyping = false;
        };

        textarea.addEventListener('blur', finalizeText);
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                finalizeText();
            }
        });
    }

    // --- Other Feature Functions ---
    function handleImageUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const point = getTransformedPoint(50, 50);
            const action = { tool: 'image', src: event.target.result, x: point.x, y: point.y };
            socket.emit('drawing-action', action);
            state.history.push(action);
            drawAction(action, ctx);
        };
        reader.readAsDataURL(file);
    }

    function downloadCanvas() {
        const link = document.createElement('a');
        link.download = `whiteboard-${sessionId}.png`;
        link.href = canvas.toDataURL();
        link.click();
    }

    // --- Canvas & History Management ---
    function redrawCanvas() {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        ctx.save();
        ctx.translate(state.pan.x, state.pan.y);
        ctx.scale(state.scale, state.scale);

        state.history.forEach(action => drawAction(action, ctx));
        if (state.drawing && state.currentShape) {
            drawAction(state.currentShape, ctx);
        }
        ctx.restore();
    }

    function drawAction(data, context) {
        const invertedColor = getInvertedColor(data.color);
        context.strokeStyle = invertedColor;
        context.fillStyle = invertedColor;
        context.lineWidth = data.size / state.scale;
        context.lineCap = 'round';
        context.lineJoin = 'round';

        switch (data.tool) {
            case 'pen': case 'eraser':
                if (data.path.length < 2) return;
                context.beginPath();
                context.moveTo(data.path[0].x, data.path[0].y);
                for (let i = 1; i < data.path.length; i++) context.lineTo(data.path[i].x, data.path[i].y);
                context.stroke();
                break;
            case 'rectangle':
                context.strokeRect(data.startX, data.startY, data.endX - data.startX, data.endY - data.startY);
                break;
            case 'circle':
                const radius = Math.hypot(data.endX - data.startX, data.endY - data.startY) / 2;
                context.beginPath();
                context.arc(data.startX + (data.endX - data.startX) / 2, data.startY + (data.endY - data.startY) / 2, radius, 0, Math.PI * 2);
                context.stroke();
                break;
            case 'line':
                context.beginPath();
                context.moveTo(data.startX, data.startY);
                context.lineTo(data.endX, data.endY);
                context.stroke();
                break;
            case 'triangle':
                context.beginPath();
                context.moveTo(data.startX + (data.endX - data.startX) / 2, data.startY);
                context.lineTo(data.startX, data.endY);
                context.lineTo(data.endX, data.endY);
                context.closePath();
                context.stroke();
                break;
            case 'arrow':
                 const headlen = 10 / state.scale;
                 const dx = data.endX - data.startX, dy = data.endY - data.startY;
                 const angle = Math.atan2(dy, dx);
                 context.beginPath();
                 context.moveTo(data.startX, data.startY);
                 context.lineTo(data.endX, data.endY);
                 context.lineTo(data.endX - headlen * Math.cos(angle - Math.PI / 6), data.endY - headlen * Math.sin(angle - Math.PI / 6));
                 context.moveTo(data.endX, data.endY);
                 context.lineTo(data.endX - headlen * Math.cos(angle + Math.PI / 6), data.endY - headlen * Math.sin(angle + Math.PI / 6));
                 context.stroke();
                 break;
            case 'text':
                context.font = `${data.fontSize / state.scale}px sans-serif`;
                context.fillText(data.text, data.x, data.y);
                break;
            case 'image':
                 const img = new Image();
                 img.onload = () => context.drawImage(img, data.x, data.y);
                 img.src = data.src;
                 break;
        }
    }

    function zoom(factor, x, y) {
        const point = getTransformedPoint(x || canvas.width / 2, y || canvas.height / 2);
        state.scale *= factor;
        state.pan.x = (x || canvas.width / 2) - point.x * state.scale;
        state.pan.y = (y || canvas.height / 2) - point.y * state.scale;
        redrawCanvas();
    }

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        redrawCanvas();
    }

    function getBackgroundColor() {
        const theme = document.body.className;
        if (theme === 'dark') return '#343a40';
        if (theme === 'colorful') return '#fffacd';
        return '#ffffff';
    }

    function getInvertedColor(color) {
        const theme = document.body.className;
        
        // Only invert colors for dark theme
        if (theme !== 'dark') return color;
        
        // Convert color to lowercase for comparison
        const lowerColor = color.toLowerCase();
        
        // Handle common black colors
        if (lowerColor === '#000000' || lowerColor === '#000' || lowerColor === 'black') {
            return '#ffffff';
        }
        
        // Handle common white colors
        if (lowerColor === '#ffffff' || lowerColor === '#fff' || lowerColor === 'white') {
            return '#000000';
        }
        
        // Handle gray scale colors (convert hex to check if it's grayscale)
        if (lowerColor.match(/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i) || 
            lowerColor.match(/^#([0-9a-f]{2})\1\1$/i)) {
            // It's a grayscale color, invert it
            const hex = lowerColor.replace('#', '');
            let r, g, b;
            
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else {
                r = parseInt(hex.substr(0, 2), 16);
                g = parseInt(hex.substr(2, 2), 16);
                b = parseInt(hex.substr(4, 2), 16);
            }
            
            // Check if it's actually grayscale (r=g=b)
            if (r === g && g === b) {
                const inverted = 255 - r;
                return `#${inverted.toString(16).padStart(2, '0').repeat(3)}`;
            }
        }
        
        // For all other colors, return as is
        return color;
    }

    function init() {
        resizeCanvas();
        setupEventListeners();
        setupSocketListeners();
        const fullURL = window.location.href;
        if (ui.sessionLink) ui.sessionLink.textContent = fullURL;
        if (ui.sessionIdDisplay) ui.sessionIdDisplay.textContent = sessionId;
    }

    init();
});

// --- Global Helper Functions ---
function copyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
        alert("Invite link copied to clipboard!");
    });
}

function logout() {
    localStorage.clear();
    window.location.href = "login.html";
}