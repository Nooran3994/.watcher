'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * STRATEGIC MEMORY & PLANNING ENGINE
 * 
 * Evolving SCAAI from a reactive assistant into a proactive partner.
 * This engine tracks the "Mission Roadmap" across sessions, ensuring
 * high-level goals are not lost in the details of immediate tasks.
 * ════════════════════════════════════════════════════════════════
 */

window._STRATEGIC_PLAN = {
    activeMission: '',
    milestones: [], // Array of { title: string, status: 'pending'|'in-progress'|'completed' }
    lastUpdate: null,
    cycleCount: 0
};

/**
 * Analyzes the recent conversation to determine if we should start a new mission,
 * update milestones on an existing mission, or close a completed mission.
 */
async function _runStrategicAnalysis(_silentCall, snapshot, userMsg) {
    console.log('[STRATEGIC] Analyzing mission progress...');
    const plan = window._STRATEGIC_PLAN;
    
    // Only run every 5 cycles or if explicit triggers are found
    plan.cycleCount = (plan.cycleCount || 0) + 1;
    const isTrigger = userMsg.match(/(?:start a new mission|strategic plan|current mission|mission status|roadmap)/i);
    
    if (plan.cycleCount % 5 !== 0 && !isTrigger) {
        return;
    }

    const currentMissionStr = plan.activeMission 
        ? `Active Mission: ${plan.activeMission}\nCurrent Milestones:\n${plan.milestones.map(m => `- [${m.status}] ${m.title}`).join('\n')}` 
        : 'No active mission right now.';

    const prompt = `You are SCAAI's Strategic Planning Module.
Your job is to track long-term, multi-step missions so the user never has to remind you of the "big picture".

Current Strategic State:
${currentMissionStr}

Recent Conversation:
${snapshot}

Instructions:
1. If the user explicitly proposes a new multi-step project or mission, define a new 'activeMission' and high-level 'milestones'.
2. If there is an active mission, evaluate the recent conversation. Have any milestones been completed? Did we start working on a pending milestone?
3. If the active mission is fully complete, clear the strategic plan.
4. Keep milestones high-level (e.g., "Implement Backend Auth", not "Write line 45 of server.js").
5. Only output valid JSON.

Output Format:
{
  "action": "create" | "update" | "close" | "none",
  "activeMission": "Title of the goal (empty string if closing/none)",
  "milestones": [
    { "title": "High-level goal", "status": "pending" | "in-progress" | "completed" }
  ],
  "reasoning": "1 sentence explaining why you made this strategic adjustment"
}`;

    try {
        const raw = await _silentCall(
            'You are an internal strategic process. Output only valid JSON.',
            prompt,
            600
        );

        if (!raw) return;

        const parsed = JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
        
        if (parsed.action && parsed.action !== 'none') {
            plan.activeMission = parsed.action === 'close' ? '' : parsed.activeMission;
            plan.milestones = parsed.action === 'close' ? [] : (parsed.milestones || []);
            plan.lastUpdate = Date.now();
            
            console.log(`[STRATEGIC] ✓ Mission updated (${parsed.action}):`, plan.activeMission || '(Cleared)');
            if (parsed.reasoning) console.log(`[STRATEGIC] Reasoning: ${parsed.reasoning}`);

            // Trigger UI update if function exists
            if (typeof window._renderProjectHomeStrategic === 'function') {
                window._renderProjectHomeStrategic();
            }

            // Persist to TOOLS_CONFIG
            try {
                if (!window.toolsConfig) window.toolsConfig = {};
                window.toolsConfig.strategicPlan = {
                    activeMission: plan.activeMission,
                    milestones: plan.milestones,
                    lastUpdate: plan.lastUpdate
                };
                if (window.scaai && window.scaai.tools) {
                    window.scaai.tools.save(window.toolsConfig).catch(() => {});
                }
            } catch (persistErr) {
                console.warn('[STRATEGIC] Failed to persist:', persistErr);
            }
        }
    } catch (e) {
        console.warn('[STRATEGIC] Parse failed:', e.message);
    }
}

// Attach to window so renderer.js can call it
window._runStrategicAnalysis = _runStrategicAnalysis;
