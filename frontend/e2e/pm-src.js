import { EditorState, Selection, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';

const sent = document.getElementById('sent');
const view = new EditorView(document.getElementById('editor'), {
  state: EditorState.create({
    schema,
    plugins: [
      // Like some chat apps: typing is handled from the editor's OWN selection on beforeinput,
      // ignoring a DOM selection the editor hasn't synced yet.
      ...(location.search.includes('beforeinput')
        ? [new Plugin({ props: { handleDOMEvents: { beforeinput(v, e) {
            if (e.inputType !== 'insertText' || e.data == null) return false;
            e.preventDefault();
            v.dispatch(v.state.tr.insertText(e.data));
            return true;
          } } } })]
        : []),
      keymap({
        // Like ChatGPT: Enter sends, Shift+Enter makes a new line.
        Enter: (state, dispatch, v) => {
          const text = state.doc.textBetween(0, state.doc.content.size, '\n').trim();
          if (!text) return true;
          const li = document.createElement('li');
          li.textContent = text;
          sent.append(li);
          v.dispatch(state.tr.delete(0, state.doc.content.size));
          return true;
        },
        'Shift-Enter': baseKeymap.Enter,
      }),
      keymap(baseKeymap),
    ],
  }),
});
view.dom.id = 'prompt-textarea';
// Like Tiptap's autofocus('end') used by chat apps: whenever the editor gains focus, the app moves
// the cursor to the end of the text a moment later.
if (location.search.includes('focusEnd')) {
  view.dom.addEventListener('focus', () => {
    setTimeout(() => view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc))), 5);
  });
}
window.pmText = () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
