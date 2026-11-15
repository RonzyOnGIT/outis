import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';

const sent = document.getElementById('sent');
// Like Claude's composer: Tiptap, Enter sends, Shift+Enter new line, autofocus at end.
const SendOnEnter = Extension.create({
  name: 'sendOnEnter',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const text = editor.getText().trim();
        if (!text) return true;
        const li = document.createElement('li');
        li.textContent = text;
        sent.append(li);
        editor.commands.clearContent(true);
        return true;
      },
      'Shift-Enter': ({ editor }) => editor.commands.first(({ commands }) => [() => commands.splitBlock()]),
    };
  },
});
const editor = new Editor({
  element: document.getElementById('editor'),
  extensions: [StarterKit, Placeholder.configure({ placeholder: 'Reply to Claude…' }), SendOnEnter],
  autofocus: 'end',
  editorProps: { attributes: { id: 'prompt-textarea', 'aria-label': 'Write your prompt' } },
});
// Claude-like: focusing the box moves the cursor to the end.
editor.on('focus', () => setTimeout(() => editor.commands.focus('end'), 0));
// Like a site with its own clipboard handling: on Cmd/Ctrl+V it reads the clipboard and inserts it itself.
if (location.search.includes('siteinsert')) {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') navigator.clipboard.readText().then((t) => editor.commands.insertContent(t));
  });
}
window.pmText = () => editor.getText({ blockSeparator: '\n' });
