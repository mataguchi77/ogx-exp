# sqlite-vec mxbai-embed Search Fix - Bugfix Design

## Overview

The Responses API's `file_search_call` tool fails with `"status": "failed"` and `"results": null` when `vector_stores_config` is not explicitly set in the stack configuration. The underlying vector store search works correctly (verified via direct `/v1/vector_stores/{id}/search` API calls), but the responses provider's `_execute_file_search_via_vector_store` method crashes with an `AttributeError` when accessing template attributes on a `None` config object. The fix applies the same fallback pattern already used elsewhere in the codebase: `config = self.vector_stores_config or VectorStoresConfig()`.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — `self.vector_stores_config` is `None` when `_execute_file_search_via_vector_store` attempts to access `.file_search_params` and `.context_prompt_params`
- **Property (P)**: The desired behavior — file search uses `VectorStoresConfig()` defaults when no explicit config is provided, and returns results successfully
- **Preservation**: When `vector_stores_config` IS explicitly set, all custom templates and annotation settings continue to be used exactly as before
- **`_execute_file_search_via_vector_store`**: Method in `tool_executor.py` that formats vector store search results into content items for the LLM context
- **`VectorStoresConfig`**: Pydantic model in `src/ogx/core/datatypes.py` with sensible defaults for all template fields (`file_search_params`, `context_prompt_params`, `annotation_prompt_params`)
- **`BuiltinResponsesImplConfig`**: Config class declaring `vector_stores_config: VectorStoresConfig | None = Field(default=None, ...)`

## Bug Details

### Bug Condition

The bug manifests when the stack configuration does not include an explicit `vector_stores_config` block in the builtin responses provider config. The `BuiltinResponsesImplConfig` class declares `vector_stores_config` as `VectorStoresConfig | None` with `default=None`. When a file search is triggered via the Responses API, `_execute_file_search_via_vector_store` accesses `self.vector_stores_config.file_search_params.header_template` (line 182), `self.vector_stores_config.file_search_params.footer_template` (line 183), and `self.vector_stores_config.context_prompt_params.context_template` (line 184) without a None check. This raises `AttributeError: 'NoneType' object has no attribute 'file_search_params'`, which propagates to `_execute_tool`'s `except Exception as e: error_exc = e` handler, causing `has_error=True` and a failed file_search_call output.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type FileSearchInvocation (vector_stores_config, query, vector_store_ids)
  OUTPUT: boolean

  RETURN input.vector_stores_config IS None
END FUNCTION
```

### Examples

- **Example 1**: User has a stack config with `mxbai-embed-large` registered as embedding model, ingests a document, searches via Responses API → `file_search_call` returns `"status": "failed"`, `"results": null`. Direct API call to `/v1/vector_stores/{id}/search` returns 4 matching chunks. Expected: Responses API returns the same results with `"status": "completed"`.
- **Example 2**: User has a minimal stack config with no `vector_stores_config` block, uses any embedding model → same failure. Expected: defaults are used and search succeeds.
- **Example 3**: User has `vector_stores_config` explicitly set with custom templates → search works correctly (this is the non-buggy path that already works).
- **Edge case**: `vector_stores_config` is set but `annotation_prompt_params.enable_annotations` is False → existing code already handles this with a fallback to `VectorStoresConfig()` defaults for annotation templates (lines 189-193), but the crash happens before reaching that code.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When `vector_stores_config` IS explicitly set, all custom `file_search_params` templates continue to be used
- When `vector_stores_config` IS explicitly set with custom `context_prompt_params`, the custom context template continues to be used
- When `annotation_prompt_params.enable_annotations = True`, annotations continue to be included
- The `search_single_store` inner function's existing None-check for `self.vector_stores_config` (for `default_search_mode`) continues to work correctly
- Vector store search failures (store not found, embedding errors) continue to propagate as errors

**Scope:**
All inputs where `self.vector_stores_config` is NOT None should be completely unaffected by this fix. This includes:
- Stacks with explicit `vector_stores_config` blocks
- Custom template configurations
- Annotation-enabled configurations
- All other tool executions (MCP tools, code_interpreter, etc.)

## Hypothesized Root Cause

Based on debugging evidence, the root cause is confirmed:

1. **Unguarded None access**: At lines 182-184 of `tool_executor.py`, the code accesses `self.vector_stores_config.file_search_params.header_template`, `.footer_template`, and `self.vector_stores_config.context_prompt_params.context_template` without checking if `self.vector_stores_config` is None.

2. **Config defaults to None**: `BuiltinResponsesImplConfig` declares `vector_stores_config: VectorStoresConfig | None = Field(default=None, ...)`. Any stack config that omits this block gets `None`.

3. **Silent exception swallowing**: The `_execute_tool` method catches ALL exceptions (`except Exception as e: error_exc = e`), so the `AttributeError` doesn't crash the server but silently causes the file_search_call to report `"status": "failed"`.

4. **Inconsistent None handling**: Earlier in the same method (line ~145), the code already checks `if self.vector_stores_config and ...` for `default_search_mode`. Later (lines 189-193), it checks `self.vector_stores_config and self.vector_stores_config.annotation_prompt_params ...` for annotations. But the template access at lines 182-184 has no such guard.

5. **Existing pattern not applied**: Other files (`vector_store.py` line 305, `openai_vector_store_mixin.py` line 776) already use `config = self.vector_stores_config or VectorStoresConfig()` to handle this exact scenario.

## Correctness Properties

Property 1: Bug Condition - File Search Succeeds Without Explicit Config

_For any_ file search invocation where `self.vector_stores_config` is None (isBugCondition returns true), the fixed `_execute_file_search_via_vector_store` method SHALL use `VectorStoresConfig()` default templates and return search results successfully without raising an `AttributeError`.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Explicit Config Continues to Be Used

_For any_ file search invocation where `self.vector_stores_config` is NOT None (isBugCondition returns false), the fixed code SHALL produce exactly the same behavior as the original code, using the explicitly configured templates for `file_search_params`, `context_prompt_params`, and `annotation_prompt_params`.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

The root cause is confirmed through debugging evidence.

**File**: `src/ogx/providers/inline/responses/builtin/responses/tool_executor.py`

**Method**: `_execute_file_search_via_vector_store`

**Specific Changes**:
1. **Add fallback variable**: Before the template access block (around line 180), add:
   ```python
   config = self.vector_stores_config or VectorStoresConfig()
   ```

2. **Replace direct access with local variable**: Change lines 182-184 from:
   ```python
   header_template = self.vector_stores_config.file_search_params.header_template
   footer_template = self.vector_stores_config.file_search_params.footer_template
   context_template = self.vector_stores_config.context_prompt_params.context_template
   ```
   To:
   ```python
   header_template = config.file_search_params.header_template
   footer_template = config.file_search_params.footer_template
   context_template = config.context_prompt_params.context_template
   ```

3. **Update annotation check**: Change the `enable_annotations` check from:
   ```python
   enable_annotations = (
       self.vector_stores_config
       and self.vector_stores_config.annotation_prompt_params
       and self.vector_stores_config.annotation_prompt_params.enable_annotations
   )
   ```
   To:
   ```python
   enable_annotations = config.annotation_prompt_params.enable_annotations
   ```

4. **Simplify annotation template access**: Since `config` is guaranteed non-None, the `if enable_annotations` / `else` block for annotation templates can use `config` directly:
   ```python
   if enable_annotations:
       chunk_annotation_template = config.annotation_prompt_params.chunk_annotation_template
       annotation_instruction_template = config.annotation_prompt_params.annotation_instruction_template
   else:
       default_config = VectorStoresConfig()
       chunk_annotation_template = default_config.annotation_prompt_params.chunk_annotation_template
       annotation_instruction_template = default_config.annotation_prompt_params.annotation_instruction_template
   ```

5. **Ensure VectorStoresConfig import**: Verify that `VectorStoresConfig` is imported from `ogx.core.datatypes` at the top of the file (it likely already is, given the existing usage in the `else` block at line 192).

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm the root cause by observing the `AttributeError` when `vector_stores_config` is None.

**Test Plan**: Write a unit test that instantiates the tool executor with `vector_stores_config=None` and calls `_execute_file_search_via_vector_store`. Run on UNFIXED code to observe the `AttributeError`.

**Test Cases**:
1. **None Config Template Access**: Call `_execute_file_search_via_vector_store` with `self.vector_stores_config = None` → assert no exception raised (will fail on unfixed code with `AttributeError`)
2. **None Config Search Results**: Call with valid vector store search results and `vector_stores_config = None` → assert content items are returned (will fail on unfixed code)
3. **None Config Annotations Disabled**: Call with `vector_stores_config = None` → assert annotations use defaults (will fail on unfixed code before reaching annotation logic)
4. **Direct API Comparison**: Call `/v1/vector_stores/{id}/search` directly → assert results returned (passes on unfixed code, proving vector store works)

**Expected Counterexamples**:
- `AttributeError: 'NoneType' object has no attribute 'file_search_params'` raised at line 182
- `_execute_tool` catches it as `error_exc`, `has_error=True`, file_search_call reports "failed"

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := _execute_file_search_via_vector_store_fixed(input.query, input.file_search_tool)
  ASSERT result IS NOT an exception
  ASSERT result.content contains formatted search results
  ASSERT templates used are VectorStoresConfig() defaults
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT _execute_file_search_via_vector_store_original(input) = _execute_file_search_via_vector_store_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many config combinations automatically to verify template selection is unchanged
- It catches edge cases where the fallback might accidentally override explicit config
- It provides strong guarantees that behavior is unchanged when config IS provided

**Test Plan**: Observe behavior on UNFIXED code with explicit `vector_stores_config` set, then write property-based tests capturing that behavior continues after the fix.

**Test Cases**:
1. **Explicit Config Preservation**: Set `vector_stores_config` with custom templates → verify those templates are used in output (passes on both unfixed and fixed code)
2. **Annotation Enabled Preservation**: Set `enable_annotations=True` with custom annotation templates → verify annotations appear in output
3. **Search Mode Preservation**: Set `chunk_retrieval_params.default_search_mode` → verify it's passed to search request
4. **Error Propagation Preservation**: Simulate vector store search failure → verify error still propagates correctly

### Unit Tests

- Test `_execute_file_search_via_vector_store` with `vector_stores_config=None` returns results using default templates
- Test `_execute_file_search_via_vector_store` with explicit `vector_stores_config` uses configured templates
- Test that `VectorStoresConfig()` defaults produce valid template strings (non-empty, contain expected placeholders)
- Test that the `config` local variable correctly falls back to defaults

### Property-Based Tests

- Generate random `VectorStoresConfig` instances (with various template strings) and verify they are used when provided
- Generate random search results and verify formatting is consistent regardless of config source (explicit vs default)
- Test that None config and explicit-default config produce identical output

### Integration Tests

- Test full Responses API flow with no `vector_stores_config` in stack config → verify file_search_call succeeds
- Test full Responses API flow with explicit `vector_stores_config` → verify custom templates are used
- Test that switching between configs (restart with different config) produces expected behavior
