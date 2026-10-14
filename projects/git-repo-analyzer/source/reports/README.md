# Example export

`cost-summary.json` and `cost-summary.txt` are CLI comparison exports from a
synthetic local repository containing `src/main.py` and `docs/guide.md`, with
the requested sparse path `src`. They are example artifacts, not analysis of
the workspace or a remote repository.

The fixture has one commit, three trees, and two blobs stored in one local
pack. It uses a fixed commit date. Initial/deferred object counts should be:

| Strategy | Initial | Deferred |
| --- | ---: | ---: |
| full | 6 | 0 |
| sparse | 4 | 0 |
| blobless | 4 | 2 |
| treeless | 1 | 5 |

Logical byte costs are separate from measured local pack/index sizes; no
future transfer size is asserted. The temporary fixture path recorded in the
report is informational and may not exist after verification.
