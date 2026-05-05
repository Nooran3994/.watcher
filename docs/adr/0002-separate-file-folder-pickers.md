# ADR-0002: Restore Separate File and Folder Pickers for Windows Compatibility

**Status:** Accepted
**Date:** 2026-04-10
**Deciders:** [USER], SCAAI Team
**Technical Story:** Revert the attempt to consolidate file and folder picking into a single UI button due to native Windows operating system limitations.

## Context

We initially attempted to streamline the chat input UI by consolidating the "Load File" (📎) and "Load Folder" (📁) buttons into a single attachment point. The goal was to simplify the interface and reinforce the "point to path" logic (referencing local paths rather than uploading).

However, during implementation and testing on Windows, we encountered a significant OS-level constraint:
1.  Electron's `dialog.showOpenDialog` with both `openFile` and `openDirectory` properties enabled triggers the Windows "Select Folder" dialog mode.
2.  In "Select Folder" mode, Windows intentionally hides individual files from the view to focus the user on directory selection.
3.  This resulted in a regression where users could not see or select individual files (e.g., in the `Downloads` folder) while using the consolidated picker.

## Decision

We will revert to providing two distinct entry points in the chat input toolbar:

1.  **File Picker (📎)**: Explicitly configured for `openFile` property to ensure all files (including those without extensions) are visible and selectable.
2.  **Folder Picker (📁)**: Explicitly configured for `openDirectory` property for reliable directory selection.

To maintain the "Point to Path" brand logic:
-   Update tooltips to "Add file paths (pointing to content)" and "Add folder path (pointing to content)".
-   Continue using the underlying system-level path referencing instead of temporary file uploads.
-   Enhanced detection logic using `fs:stat` in the main process to robustly categorize selections.

## Consequences

### Positive
-   Restores full visibility of all file types on Windows.
-   Reduces user confusion regarding "missing files" in the Downloads directory.
-   Maintains clear semantic separation between file-level and directory-level context.

### Negative
-   Increases the number of icons in the chat input toolbar by one.

### Neutral
-   Requires maintenance of two separate IPC pathways for picking (`fs:open-files` and `fs:open-folder`).

## Implementation Roadmap

### Phase 1: IPC Refinement
-   Modified `main.js`: Added the `fs:stat` handler for robust path identification.
-   Modified `main.js`: Updated `fs:open-files` to remove the `openDirectory` property, restoring the file-specific view.

### Phase 2: UI Restoration
-   Modified `index.html`: Re-added the `📁` button (ID `fbtn`) between the attachment and search icons.
-   Updated CSS/HTML tooltips to explain the "Point to Path" behavior.

### Phase 3: Logic Cleanup
-   Modified `index.html`: Simplified `doOpenFiles` to focus on standard file selection.
-   Verified `doOpenFolder` remains correctly wired to the restored button.

## References
-   Electron Documentation: `dialog.showOpenDialog` properties.
-   SCAAI UI Layout Update (2026-04-10).
-   Windows Common Item Dialog specification.
