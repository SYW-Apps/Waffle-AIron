import 'react';

// React 18's DOM typings predate the HTML popover attribute (used by the toast
// stack and the tooltip layer to enter the top layer above modal dialogs).
declare module 'react' {
  interface HTMLAttributes<T> {
    popover?: 'auto' | 'manual' | '';
  }
}
