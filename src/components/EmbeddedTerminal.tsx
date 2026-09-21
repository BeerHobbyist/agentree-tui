/**
 * Registers OpenTUI's EmbeddedTerminalRenderable as the `<embedded-terminal>`
 * JSX element. Importing this module for its side effect runs `extend()`.
 */
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/react";

extend({ "embedded-terminal": EmbeddedTerminalRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "embedded-terminal": typeof EmbeddedTerminalRenderable;
  }
}

export type EmbeddedTerminalProps = ExtendedComponentProps<
  typeof EmbeddedTerminalRenderable
>;

export { EmbeddedTerminalRenderable };
