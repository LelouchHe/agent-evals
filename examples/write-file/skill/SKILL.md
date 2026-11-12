---
name: write-requested-file
description: Write a file at a requested path with specific content. Use when a task asks to create or overwrite a file with given text.
---

# Write a requested file

When the task asks for a file with specific content:

1. Resolve the requested path relative to the current working directory.
2. Write the requested content to that path with the file-writing tool.
3. Read the file back and confirm its content matches the request.

Do not modify unrelated files.
