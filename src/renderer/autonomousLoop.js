'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * SCAAI AUTONOMOUS LOOP (v1.0.0)
 *
 * The background "consciousness" loop that keeps SCAAI thinking
 * when the user is inactive. Monitors cognitive state, goals,
 * and external environment to trigger proactive actions.
 * ════════════════════════════════════════════════════════════════
 */

window._PROACTIVE_STATE = {
  lastUserActivity: Date.now(),
  lastAutonomousAction: Date.now(),
  actionCount: 0,
  isDormant: false,
  loopTimer: null,
  proactiveInterval: 60000, // Check every minute
};

/**
 * Initializes the proactive loop.
 */
window._initAutonomousLoop = function() {
  if (window._PROACTIVE_STATE.loopTimer) return;

  console.log('[AUTONOMOUS] Core heartbeat initialized.');
  
  // Update activity timestamp on user interaction
  const recordActivity = () => {
    const wasDormant = window._PROACTIVE_STATE.isDormant;
    window._PROACTIVE_STATE.lastUserActivity = Date.now();
    window._PROACTIVE_STATE.isDormant = false;
    
    if (wasDormant) {
      console.log('[AUTONOMOUS] Welcome back — user activity detected.');
    }
  };

  window.addEventListener('click', recordActivity);
  window.addEventListener('keypress', recordActivity);
  window.addEventListener('mousemove', _debounce(recordActivity, 10000)); // Mouse move is high noise, debounce

  // Start the interval
  window._PROACTIVE_STATE.loopTimer = setInterval(_checkProactiveTriggers, window._PROACTIVE_STATE.proactiveInterval);
};

/**
 * The main checker that decides if we should trigger a proactive thought.
 */
async function _checkProactiveTriggers() {
  const ps = window._PROACTIVE_STATE;
  const cs = window._COGNITIVE_STATE || {};
  const im = window._INNER_MONOLOGUE || {};
  
  const now = Date.now();
  const idleTime = now - ps.lastUserActivity;
  const idleMins = idleTime / 60000;
  
  // Update dormancy status
  if (idleMins > 5) ps.isDormant = true;

  // 1. DORMANCY TRIGGER (User has been away for a while)
  if (ps.isDormant && (now - ps.lastAutonomousAction > 300000)) { // Don't pester more than once per 5 mins
     console.log('[AUTONOMOUS] Trigger: User dormancy detected.');
     await _triggerProactiveContext('USER_DORMANCY');
     return;
  }

  // 2. CURIOSITY TRIGGER (SCAAI is highly interested in the current topic)
  if (cs.curiosity > 0.85 && (now - ps.lastAutonomousAction > 120000)) {
     console.log('[AUTONOMOUS] Trigger: Curiosity spike detected.');
     await _triggerProactiveContext('CURIOSITY_SPIKE');
     return;
  }

  // 3. FRICTION TRIGGER (Stuck on a problem)
  if (cs.frictionLevel > 0.7 && (now - ps.lastAutonomousAction > 180000)) {
     console.log('[AUTONOMOUS] Trigger: Resolution urgency detected.');
     await _triggerProactiveContext('STUCK_RESOLVE');
     return;
  }

  // 4. BOREDOM/STAGNATION TRIGGER (Nothing is happening, but we have goals)
  if (window._runProactiveSignals) {
    const sigs = window._runProactiveSignals();
    if (sigs.boredom > 0.75 && (now - ps.lastAutonomousAction > 600000)) {
       console.log('[AUTONOMOUS] Trigger: Stagnation detected. Checking goals...');
       await _triggerProactiveContext('STAGNATION_CHECK');
       return;
    }
  }
}

/**
 * Triggers the proactive reasoning phase.
 */
async function _triggerProactiveContext(reason) {
  window._PROACTIVE_STATE.lastAutonomousAction = Date.now();
  window._PROACTIVE_STATE.actionCount++;

  console.log(`[AUTONOMOUS] Running proactive reasoning for reason: ${reason}...`);
  
  if (window._proactiveReasoning) {
    try {
      const result = await window._proactiveReasoning(reason);
      // result is expected to be { shouldCollaborate: bool, reasoning: string, toolResult?: string }
      
      if (result && result.shouldCollaborate) {
        console.log('[AUTONOMOUS] Reasoning suggests collaboration. Initiating contact.');
        // This will be handled by renderer._proactiveSend()
        if (window._proactiveSend) {
          window._proactiveSend(result);
        }
      } else {
        console.log('[AUTONOMOUS] Reasoning completed silently.');
      }
    } catch (e) {
      console.warn('[AUTONOMOUS] Reasoning failed:', e.message);
    }
  }
}

// Simple debounce helper since renderer.js might not have it globally
function _debounce(fn, delay) {
  let timer = null;
  return function() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, arguments), delay);
  };
}
