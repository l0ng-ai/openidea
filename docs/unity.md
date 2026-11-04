# Unity projects

Open the folder containing `Assets` and `ProjectSettings/ProjectVersion.txt`.
OpenIDEA detects Unity without requiring a generated solution and shows the editor
version in the Unity project view.

The Unity view hides `.meta` files, generated C# project files and cache/build
folders. **Show Meta Files** and **Show Generated Files** reveal them independently;
the regular Project view is still available. Generated folders are excluded from
indexing and search, including folders Unity creates after the project is opened.

Operations on assets inside `Assets` include their `.meta` files. Rename and move
preserve GUIDs, deletion removes both files, and copy generates new GUIDs and updates
references within the copied group. References to assets outside the group stay
unchanged. File move undo and transactional workspace edits include metadata too.
Destination metadata conflicts are rejected before making changes.

Projects may be opened through a linked root or parent directory, including macOS
`/var` and `/tmp`. Links inside the project (including Windows junctions) are not
followed by asset operations. For moves/copies to or from ordinary directories,
the external path must have no linked ancestors. Cross-volume asset moves and
copies that require rewriting binary serialized assets are rejected; use Unity
for those operations.
