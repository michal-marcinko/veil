import { describe, it, expect } from "vitest";
import { Document, Page, Text, View, StyleSheet, pdf } from "@react-pdf/renderer";

describe("@react-pdf/renderer imports", () => {
  it("exports the primitives we depend on", () => {
    expect(Document).toBeDefined();
    expect(Page).toBeDefined();
    expect(Text).toBeDefined();
    expect(View).toBeDefined();
    expect(typeof StyleSheet.create).toBe("function");
    expect(typeof pdf).toBe("function");
  });
});
