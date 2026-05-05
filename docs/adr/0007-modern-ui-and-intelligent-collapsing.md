# ADR-0007: Modern UI & Intelligent Collapsing

**Status:** Accepted
**Date:** 2026-04-11
**Deciders:** SCAAI Team, User

## Context

As the SCAAI platform evolves, AI responses have become significantly more detailed and multi-part (often including several large code blocks and terminal logs). The previous UI used a uniform collapsing threshold and a basic layout which led to several issues:
1. **Layout Clutter**: Long messages effectively "stretched" the screen, requiring excessive scrolling.
2. **Visual Noise**: Repeating avatars and metadata for consecutive messages created a fragmented reading experience.
3. **Rigid Truncation**: A "one-size-fits-all" threshold was too restrictive for AI reasoning but sometimes too loose for long user-pasted content.
4. **Lack of Contrast**: The side-by-side layout didn't clearly separate the user's intent from the AI's response in complex threads.

## Decision

We have implemented a dual-vector update to the SCAAI Frontend:

### 1. Modern Aesthetic (UI)
- **Glassmorphism**: Switched to semi-transparent bubbles with `backdrop-filter: blur(8px)` to create depth and modern appeal.
- **Alternating Alignment**: Your messages (YOU) are now right-aligned, while SCAAI responses are left-aligned, establishing a clear visual hierarchy.
- **Message Bundling**: Consecutive messages from the same sender now hide avatars and metadata, tightening the vertical rhythm.
- **Micro-Animations**: Added entrance fades and smooth theme transitions to make the UI feel "alive."

### 2. Intelligent Collapsing (UX)
- **Tiered Thresholds**:
    - AI: 25 lines / 1800 chars (Generous - prioritizes visibility of complex logic).
    - User: 5 lines / 400 chars (Strict - keeps the "prompt" part of the chat concise).
- **Granular Code Truncation**: Applied collapsing to individual `mkCode` blocks exceeding 15 lines within a larger message.
- **Bulk Controls**: Added "Expand All" to the message sidebar for bulk state manipulation.

## Consequences

### Positive
- **Improved Scannability**: The alternating layout and bundling make it easier to follow the thread of conversation.
- **Reduced Cognitive Load**: Collapsing code blocks by default prevents "wall of code" fatigue while still allowing full access.
- **Premium Brand Alignment**: The UI now matches the high-quality engineering standards of the platform.

### Negative
- **Layout Complexity**: CSS for right-aligned bubbles in a flex container requires careful management of `max-width` to prevent overflow issues on small screens.
- **Click Overhead**: Users may need to click "Read More" more often during deep debugging sessions (mitigated by the 25-line AI threshold).

## Alternatives Considered

### Alternative 1: Full-width Bubbles
**Description:** Keeping all messages 100% width.
**Pros:** Simpler CSS.
**Cons:** Poor scannability; doesn't feel like a modern chat interface.

### Alternative 2: Collapsing only Code Blocks
**Description:** Truncating code but never the text of a message.
**Pros:** Preserves all reasoning text.
**Cons:** Doesn't solve the issue of extremely long text responses (e.g. stories, lists, logs).

## References
- [Issue: Chat UI Collapsing Refinement]
- [PR: Modern Aesthetic Overhaul]
