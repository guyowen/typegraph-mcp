import { fixtureDependency } from "./fixture-dependency.js"

export interface ExampleResult {
  readonly value: number
  readonly source: string
}

export function createExample(value: number): ExampleResult {
  return {
    value: value + fixtureDependency,
    source: "install fixture",
  }
}
