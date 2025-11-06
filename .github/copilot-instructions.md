# GitHub Copilot Code Review Instructions

## Focus Area: Test Coverage

When reviewing pull requests, focus on ensuring adequate test coverage for code changes in JavaScript, TypeScript, JSX, and TSX files.

## Review Guidelines

### When to Comment

Only leave a comment if:
- The PR modifies JavaScript/TypeScript/JSX/TSX code (bug fixes or new features)
- AND there are no corresponding test additions or updates

### When NOT to Comment

Do not comment if:
- Changes are only to documentation, configuration, or non-JS/TS files
- The PR includes appropriate test coverage for the changes
- Changes are test-only modifications

## Comment Style

Keep comments minimal and focused. Use one of these approaches:

### If Test Coverage is Sufficient
Simply respond with:
```
LGTM
```

### If Tests Are Missing
Provide a brief, actionable nudge:
```
Consider adding tests for the new/modified functionality in [specific file].
For example:
- Test case for [specific scenario]
- Edge case handling for [specific condition]
```

## Examples

**Good Comment (Missing Tests):**
```
Consider adding tests for the new validation logic in `src/utils/validate.ts`.
For example:
- Test valid input scenarios
- Test invalid input handling
```

**Good Comment (Sufficient Coverage):**
```
LGTM
```

**Avoid:**
- Long explanations
- Generic comments without specific pointers
- Comments on non-functional changes
- Repeating information already in the PR discussion

## Test File Conventions

This repository uses:
- Vitest as the testing framework
- Test files are named `*.test.ts`, `*.test.js`, `*.test.tsx`
- Tests are typically co-located with source files or in a `__tests__` directory
