# Local data directory

The legacy loopback service creates its source and generated data files in this
directory on first startup. Those files can contain user-selected prompt text
and therefore are intentionally excluded from version control.

Tests use isolated temporary directories and do not read or modify this folder.
