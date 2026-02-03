import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Comfy.InfinityCanvas",
    async setup() {
        console.log("🎨 Infinity Canvas Extension: Initializing...");

        const glassIcon = `
        <svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align: middle; margin-right: 6px;">
          <path d="M7 9c-2.5 0-4.5 1.5-4.5 3.5s2 3.5 4.5 3.5c1.5 0 3-1 4.5-3.5C10 10 8.5 9 7 9Z" fill="#7ed6df" opacity="0.9"/>
          <path d="M17 9c2.5 0 4.5 1.5 4.5 3.5s-2 3.5-4.5 3.5c-1.5 0-3-1-4.5-3.5 1.5-2.5 3-3.5 4.5-3.5Z" fill="#e056fd" opacity="0.9"/>
        </svg>`;

        const btn = document.createElement("button");
        btn.id = "infinity-canvas-main-button";
        btn.innerHTML = `${glassIcon} Infinity Canvas`;

        // Load saved position from localStorage
        const STORAGE_KEY = 'infinityCanvas_buttonPosition';
        let savedPos = null;
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) savedPos = JSON.parse(saved);
        } catch (e) {
            console.warn("Failed to load button position:", e);
        }

        // Helper to apply position based on anchor
        function applyAnchoredPosition(pos) {
            if (!pos || !pos.anchor) return false;
            
            btn.style.top = "auto";
            btn.style.bottom = "auto";
            btn.style.left = "auto";
            btn.style.right = "auto";
            
            // Apply vertical position
            if (pos.anchor.includes("top")) {
                btn.style.top = pos.offsetY + "px";
            } else {
                btn.style.bottom = pos.offsetY + "px";
            }
            
            // Apply horizontal position
            if (pos.anchor.includes("left")) {
                btn.style.left = pos.offsetX + "px";
            } else {
                btn.style.right = pos.offsetX + "px";
            }
            
            return true;
        }

        // Helper to calculate and save anchored position
        function saveAnchoredPosition() {
            const rect = btn.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const windowCenterX = window.innerWidth / 2;
            const windowCenterY = window.innerHeight / 2;
            
            // Determine nearest corner
            const isLeft = centerX < windowCenterX;
            const isTop = centerY < windowCenterY;
            
            const anchor = (isTop ? "top" : "bottom") + "-" + (isLeft ? "left" : "right");
            
            // Calculate offset from that corner
            let offsetX, offsetY;
            if (isLeft) {
                offsetX = rect.left;
            } else {
                offsetX = window.innerWidth - rect.right;
            }
            if (isTop) {
                offsetY = rect.top;
            } else {
                offsetY = window.innerHeight - rect.bottom;
            }
            
            const pos = { anchor, offsetX, offsetY };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
            console.log("📍 [Infinity] Button position saved:", pos);
            return pos;
        }

        Object.assign(btn.style, {
            position: "fixed",
            zIndex: "9999",
            backgroundColor: "#33434F",
            color: "white",
            border: "none",
            padding: "5px 10px",
            borderRadius: "6px",
            cursor: "move",
            fontSize: "12px",
            fontWeight: "600",
            display: "flex",
            alignItems: "center",
            boxShadow: "0 2px 5px rgba(0,0,0,0.3)",
            transition: "background-color 0.2s",
            userSelect: "none"
        });

        // Apply saved position or default to top-right
        if (!applyAnchoredPosition(savedPos)) {
            btn.style.top = "23px";
            btn.style.right = "20px";
        }

        btn.onmouseover = () => btn.style.backgroundColor = "#455a6a";
        btn.onmouseout = () => btn.style.backgroundColor = "#33434F";

        // Dragging functionality
        let isDragging = false;
        let wasDragged = false;
        let dragStartX, dragStartY;
        let initialLeft, initialTop;
        const DRAG_THRESHOLD = 5;

        function onBtnMouseDown(e) {
            if (e.button !== 0) return;
            
            isDragging = true;
            wasDragged = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            
            // Get current position
            const rect = btn.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            
            // Switch to left/top positioning for dragging
            btn.style.right = "auto";
            btn.style.bottom = "auto";
            btn.style.left = initialLeft + "px";
            btn.style.top = initialTop + "px";
            
            document.addEventListener('mousemove', onBtnMouseMove);
            document.addEventListener('mouseup', onBtnMouseUp);
            e.preventDefault();
        }

        function onBtnMouseMove(e) {
            if (!isDragging) return;
            
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            
            if (!wasDragged && (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD)) {
                wasDragged = true;
                btn.style.opacity = "0.85";
            }
            
            if (wasDragged) {
                let newLeft = initialLeft + deltaX;
                let newTop = initialTop + deltaY;
                
                // Constrain to viewport
                const maxX = window.innerWidth - btn.offsetWidth;
                const maxY = window.innerHeight - btn.offsetHeight;
                newLeft = Math.max(0, Math.min(newLeft, maxX));
                newTop = Math.max(0, Math.min(newTop, maxY));
                
                btn.style.left = newLeft + "px";
                btn.style.top = newTop + "px";
            }
        }

        function onBtnMouseUp(e) {
            document.removeEventListener('mousemove', onBtnMouseMove);
            document.removeEventListener('mouseup', onBtnMouseUp);
            
            btn.style.opacity = "1";
            
            if (wasDragged) {
                // Save anchored position and re-apply it
                const pos = saveAnchoredPosition();
                applyAnchoredPosition(pos);
            }
            
            isDragging = false;
            // wasDragged is checked in onclick to prevent activation
        }

        btn.addEventListener('mousedown', onBtnMouseDown);

        let globalCanvasWin = null;
        let lastWorkflowJSON = null;
        let syncInterval = null;

        // AUTO-SYNC FUNCTION
        async function syncWorkflowToCanvas() {
            if (!globalCanvasWin || globalCanvasWin.closed) {
                if (syncInterval) {
                    clearInterval(syncInterval);
                    syncInterval = null;
                    console.log("⏸️ [Infinity] Auto-sync stopped (window closed)");
                }
                return;
            }

            try {
                const p = await app.graphToPrompt();
                const currentJSON = JSON.stringify(p?.output || {});

                // Only sync if workflow actually changed
                if (currentJSON !== lastWorkflowJSON) {
                    lastWorkflowJSON = currentJSON;
                    globalCanvasWin.postMessage({
                        type: "SYNC_WORKFLOW",
                        workflow: p?.output || {}
                    }, "*");
                    console.log("🔄 [Infinity] Workflow auto-synced");
                }
            } catch (err) {
                console.error("❌ [Infinity] Auto-sync error:", err);
            }
        }

        // START AUTO-SYNC
        function startAutoSync() {
            if (syncInterval) return; // Already running
            
            syncInterval = setInterval(syncWorkflowToCanvas, 1000); // Check every second
            console.log("▶️ [Infinity] Auto-sync started (1s interval)");
        }

        // STOP AUTO-SYNC
        function stopAutoSync() {
            if (syncInterval) {
                clearInterval(syncInterval);
                syncInterval = null;
                console.log("⏹️ [Infinity] Auto-sync stopped");
            }
        }

        btn.onclick = async (e) => {
            // Prevent activation if we just finished dragging
            if (wasDragged) {
                wasDragged = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            
            console.log("🔍 [Infinity] Grabbing workflow...");

            try {
                const p = await app.graphToPrompt();
                console.log("📋 [Infinity] Workflow data:", p);

                if (!p || !p.output) {
                    console.warn("⚠️ [Infinity] No workflow data available");
                    alert("Warning: No workflow detected. The canvas will open but may not function correctly.");
                }

                // Check if window is already open
                if (globalCanvasWin && !globalCanvasWin.closed) {
                    console.log("♻️ [Infinity] Canvas already open. Sending sync...");
                    lastWorkflowJSON = JSON.stringify(p?.output || {});
                    globalCanvasWin.postMessage({
                        type: "SYNC_WORKFLOW",
                        workflow: p?.output || {}
                    }, "*");
                    globalCanvasWin.focus();
                } else {
                    console.log("🆕 [Infinity] Opening new Canvas window...");
                    globalCanvasWin = window.open(
                        "./extensions/ComfyUI-Infinity-Canvas/index.html",
                        "InfinityCanvas"
                    );

                    if (!globalCanvasWin) {
                        alert("Failed to open window. Please check if popups are blocked.");
                        return;
                    }

                    lastWorkflowJSON = JSON.stringify(p?.output || {});

                    // Wait for canvas to be ready
                    const handleMessage = (event) => {
                        if (event.data === "CANVAS_READY") {
                            console.log("✅ [Infinity] Canvas ready, sending workflow");
                            globalCanvasWin.postMessage({
                                type: "SYNC_WORKFLOW",
                                workflow: p?.output || {}
                            }, "*");
                            window.removeEventListener("message", handleMessage);
                            
                            // Start auto-sync after initial connection
                            startAutoSync();
                        }
                    };
                    window.addEventListener("message", handleMessage);

                    // Timeout fallback
                    setTimeout(() => {
                        if (globalCanvasWin && !globalCanvasWin.closed) {
                            console.log("⏰ [Infinity] Timeout - sending workflow anyway");
                            globalCanvasWin.postMessage({
                                type: "SYNC_WORKFLOW",
                                workflow: p?.output || {}
                            }, "*");
                            startAutoSync();
                        }
                        window.removeEventListener("message", handleMessage);
                    }, 2000);
                }

            } catch (err) {
                console.error("❌ [Infinity] CRITICAL ERROR:", err);
                alert("Failed to open Infinity Canvas. Check console for details.");
            }
        };

        // Robust injection
        function injectButton() {
            if (!document.getElementById("infinity-canvas-main-button")) {
                document.body.appendChild(btn);
                console.log("✅ [Infinity] Button injected into body.");
            }
        }

        // Inject immediately and keep checking
        injectButton();
        setInterval(injectButton, 2000);

        // Cleanup on page unload
        window.addEventListener("beforeunload", () => {
            stopAutoSync();
            if (globalCanvasWin && !globalCanvasWin.closed) {
                globalCanvasWin.close();
            }
        });

        console.log("✨ [Infinity] Extension setup complete");
    }
});