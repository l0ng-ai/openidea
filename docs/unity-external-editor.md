# Open scripts from Unity

OpenIDEA can open scripts and Console source locations without a Unity plugin.

1. In Unity, open **Edit > Preferences > External Tools** (on macOS,
   **Unity > Settings/Preferences > External Tools**).
2. Under **External Script Editor**, choose **Browse** and select OpenIDEA's
   executable (or its `.app` on macOS).
3. Set **External Script Editor Args** to:

   ```text
   $(ProjectPath) --file $(File) --line $(Line) --column $(Column)
   ```

Unity 2022.3 quotes the expanded project and file paths itself, including paths
with spaces. Do not add another pair of quotes around these placeholders.

Double-click a script in the Project window or a source location in the Console.
OpenIDEA opens the project and file, or focuses its existing project window, then
places the caret at the supplied location. Other open tabs stay in place.

The project argument makes cold launches open the Unity project rather than a
standalone file. Without it, `--file` opens in an existing matching project window
or in LightEdit. Relative file paths resolve against the supplied project folder,
or against the launch working directory when no project is supplied.

For a direct invocation of the application executable, quote paths as required
by your shell. The separately installed `openidea` command has its own syntax:

```text
/path/to/openidea "/path/to/My Game" --file "/path/to/My Game/Assets/Player.cs" --line 12 --column 5
```

`--file=...`, `--line=...` and `--column=...` also work. Lines and columns are
1-based; Unity's `0` and `-1` mean an unknown position. An omitted or unknown
column uses the start of the line. Without a known line, the file opens without
an explicit caret position. Invalid arguments and missing files report an error.

On Windows, use the same permissions for Unity and OpenIDEA when possible.
If a running instance does not receive a request, restart both applications with
matching permissions and retry. This integration opens local projects; it does
not generate C# project files or attach a debugger.
