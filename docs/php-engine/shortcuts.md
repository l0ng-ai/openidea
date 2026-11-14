# Keyboard shortcuts for PHP and Laravel

There are no PHP-only or Laravel-only shortcuts. The engine sits behind the IDE's standard code-insight actions, and the Laravel features are reached through those same actions on a string, class or template.

The bindings below are the IntelliJ Windows keymap (`src/platform/keymaps/intellij-windows.ts`). The VS Code and Eclipse presets, and any binding changed in Settings › Keymap, differ.

## Completion and information

| Shortcut       | What it does                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+Space`   | Code completion: members, classes, and Laravel strings (route names, views, config keys, translations, columns, validation rules, Artisan commands) |
| `Ctrl+P`       | Parameter info for the call at the caret                                                                                                            |
| `Ctrl+Q`       | Quick documentation (the hover text: types, PHPDoc, route details, column source, translation text)                                                 |
| `Ctrl+Shift+P` | Type of the expression at the caret                                                                                                                 |
| `Ctrl+Shift+I` | Quick definition: shows the declaration in a popup without leaving the file                                                                         |
| `Ctrl+F1`      | Description of the error or warning at the caret                                                                                                    |
| `Alt+Q`        | Context info: shows the enclosing class or method header                                                                                            |

## Navigation

| Shortcut                           | What it does                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+B` or `Ctrl+Click`           | Go to declaration; on Laravel strings, opens the route, view, config entry, translation, migration column, policy method, command class and so on |
| `Ctrl+Alt+B`                       | Go to implementations or subclasses                                                                                                               |
| `Ctrl+Shift+B`                     | Go to the declaration of the expression's type                                                                                                    |
| `Ctrl+U`                           | Go to the parent method                                                                                                                           |
| `Ctrl+H`                           | Type hierarchy                                                                                                                                    |
| `Ctrl+Alt+H`                       | Call hierarchy                                                                                                                                    |
| `Ctrl+F12`                         | File structure popup                                                                                                                              |
| `Alt+Down` / `Alt+Up`              | Next / previous method                                                                                                                            |
| `Ctrl+Shift+T`                     | Go to the test of the class, or back                                                                                                              |
| `Ctrl+N`                           | Go to class                                                                                                                                       |
| `Ctrl+Shift+N`                     | Go to file                                                                                                                                        |
| `Ctrl+Alt+Shift+N`                 | Go to symbol                                                                                                                                      |
| `Shift Shift`                      | Search Everywhere; its **Routes** and **Laravel Generators** tabs are here                                                                        |
| `Ctrl+Shift+A`                     | Find Action: the way to run actions with no key, such as _Run Artisan Command…_ and _Laravel Generate…_                                           |
| `Ctrl+Alt+Left` / `Ctrl+Alt+Right` | Back / forward                                                                                                                                    |
| `Ctrl+[` / `Ctrl+]`                | Start / end of the code block                                                                                                                     |
| `Ctrl+Shift+M`                     | Matching brace                                                                                                                                    |

## Usages

| Shortcut                        | What it does                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Alt+F7`                        | Find Usages in the tool window (works on route names, views, config keys, abilities, macros and so on) |
| `Ctrl+Alt+F7`                   | Show usages in a popup                                                                                 |
| `Ctrl+Shift+F7`                 | Highlight usages in the current file                                                                   |
| `Ctrl+Alt+Down` / `Ctrl+Alt+Up` | Next / previous highlighted usage                                                                      |

## Inspections, quick-fixes and intentions

| Shortcut          | What it does                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Alt+Enter`       | Show quick-fixes and intentions: create view/component/page/translation, add to `.env.example`, convert rules, promote to Form Request, inject facade, convert scope and so on |
| `Alt+Shift+Enter` | Apply the preferred quick-fix directly                                                                                                                                         |
| `F2` / `Shift+F2` | Next / previous problem in the file                                                                                                                                            |
| `Alt+Shift+I`     | Inspect the current file                                                                                                                                                       |

## Refactoring

| Shortcut           | What it does                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `Shift+F6`         | Rename (symbols, and Laravel names: routes, views, config and translation keys, Artisan options, abilities, Livewire components) |
| `Ctrl+Alt+Shift+T` | Refactor This menu                                                                                                               |
| `Ctrl+F6`          | Change signature                                                                                                                 |
| `F6`               | Move                                                                                                                             |
| `Ctrl+Alt+V`       | Extract variable                                                                                                                 |
| `Ctrl+Alt+M`       | Extract method                                                                                                                   |
| `Ctrl+Alt+C`       | Extract constant                                                                                                                 |
| `Ctrl+Alt+F`       | Extract field                                                                                                                    |
| `Ctrl+Alt+P`       | Extract parameter                                                                                                                |
| `Ctrl+Alt+N`       | Inline                                                                                                                           |
| `Alt+Delete`       | Safe delete                                                                                                                      |

## Generating and formatting code

| Shortcut                  | What it does                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Alt+Insert`              | Generate menu in the editor (constructor, getters/setters, PHPDoc; in a model also JSON resource, factory, add all fields to `$fillable`). In the Project view it is New, which holds Laravel › Generate |
| `Ctrl+O`                  | Override methods                                                                                                                                                                                         |
| `Ctrl+I`                  | Implement methods                                                                                                                                                                                        |
| `Ctrl+Alt+L`              | Reformat code (PHP and Blade)                                                                                                                                                                            |
| `Ctrl+Alt+Shift+L`        | Reformat dialog                                                                                                                                                                                          |
| `Ctrl+Alt+O`              | Optimize imports                                                                                                                                                                                         |
| `Ctrl+Alt+I`              | Auto-indent lines                                                                                                                                                                                        |
| `Ctrl+Alt+T`              | Surround with                                                                                                                                                                                            |
| `Ctrl+J`                  | Insert live template                                                                                                                                                                                     |
| `Ctrl+Shift+Enter`        | Complete statement                                                                                                                                                                                       |
| `Ctrl+/` / `Ctrl+Shift+/` | Line / block comment                                                                                                                                                                                     |

## Running (Artisan run configurations, tests)

| Shortcut                         | What it does                                               |
| -------------------------------- | ---------------------------------------------------------- |
| `Ctrl+Shift+F10`                 | Run what is at the caret (a console command class, a test) |
| `Shift+F10` / `Shift+F9`         | Run / debug the selected configuration                     |
| `Alt+Shift+F10` / `Alt+Shift+F9` | Choose a configuration to run / debug                      |
| `Ctrl+F5`                        | Rerun                                                      |
| `Ctrl+F2`                        | Stop                                                       |

## Laravel features without a shortcut

Three Laravel features have no key by default:

- **Run Artisan Command…**
- **Laravel Generate…**
- **Model view**, opened from the code lens or the gutter icon on a model class.

The first two can be given a key in Settings › Keymap, or by pressing `Alt+Enter` on the action in Search Everywhere.

General editing keys (carets, folding, line moves, bookmarks, debugger stepping) aren't listed here: they don't involve the engine.
