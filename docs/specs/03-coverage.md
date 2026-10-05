# 03. Coverage per agent

**Status:** draft
**Outcome:** The person sees how well each agent built its context: what it read, what it only searched, and what it changed.
**Actors:** the person

## Requirements

### COV-1 Per agent, this session

The pane's Coverage section lists each agent active in the session, including the main session, with:

- files read in full;
- files only seen through a search;
- files edited;
- for each edit, whether the file was understood first;
- cards written.

**Acceptance**

- Given a lane that read 4 files, grepped 3 and edited 2 (one understood, one edited after a refused attempt and then a full read), when the section draws, then those counts and both edits appear with their state.

### COV-2 Live

Coverage updates within 2 seconds of a read, search or edit, and never makes a model call.

**Acceptance**

- Given the section is open, when an agent reads a file, then its read count rises within 2 seconds.

### COV-3 Edits without understanding stand out

An edit made without understanding (where the hooks are set to nudge rather than block) is marked, with the files that were still unread.

**Acceptance**

- Given `read_before_edit = "nudge"` and an edit without its imports read, when the section draws, then the edit is marked and lists the unread imports.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
