# Bugfix Requirements Document

## Introduction

When using the Responses API's `file_search_call` tool, the call returns `"status": "failed"` with `"results": null` if the stack configuration does not explicitly set `vector_stores_config` in the builtin responses provider config. The root cause is that `_execute_file_search_via_vector_store` in `tool_executor.py` accesses `self.vector_stores_config.file_search_params` (and other template attributes) without checking if `self.vector_stores_config` is `None`. Since `BuiltinResponsesImplConfig` declares `vector_stores_config: VectorStoresConfig | None = Field(default=None, ...)`, any stack that omits this config block will hit an `AttributeError: 'NoneType' object has no attribute 'file_search_params'`, which is caught by the generic exception handler in `_execute_tool`, setting `error_exc` and causing the file_search_call to report failure.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `_execute_file_search_via_vector_store` is called AND `self.vector_stores_config` is `None` (not set in stack config) THEN accessing `self.vector_stores_config.file_search_params.header_template` raises `AttributeError: 'NoneType' object has no attribute 'file_search_params'`

1.2 WHEN the `AttributeError` is raised inside `_execute_file_search_via_vector_store` THEN it propagates to `_execute_tool` which catches it as `error_exc`, setting `has_error=True`

1.3 WHEN `has_error=True` for a file_search tool call THEN the Responses API emits a `file_search_call` output with `"status": "failed"` and `"results": null`

1.4 WHEN the vector store search API (`/v1/vector_stores/{id}/search`) is called directly THEN it returns correct results (e.g., 4 matching chunks), proving the vector store and embeddings work correctly

### Expected Behavior (Correct)

2.1 WHEN `_execute_file_search_via_vector_store` is called AND `self.vector_stores_config` is `None` THEN the method SHALL fall back to `VectorStoresConfig()` defaults (which provide sensible default templates) instead of raising an exception

2.2 WHEN `self.vector_stores_config` is `None` THEN the file search SHALL use the default `header_template`, `footer_template`, and `context_template` from `VectorStoresConfig()` and return search results successfully

2.3 WHEN a document has been successfully ingested into a vector store and a search query is issued via the Responses API THEN the `file_search_call` SHALL return matching results with `"status": "completed"` regardless of whether `vector_stores_config` is explicitly set in the stack config

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `vector_stores_config` IS explicitly set in the stack config THEN the method SHALL CONTINUE TO use the configured templates from `self.vector_stores_config` exactly as before

3.2 WHEN `vector_stores_config` is set with custom `file_search_params` templates THEN those custom templates SHALL CONTINUE TO be used for formatting search results

3.3 WHEN `vector_stores_config` is set with `annotation_prompt_params.enable_annotations = True` THEN annotations SHALL CONTINUE TO be included in the search output

3.4 WHEN `vector_stores_config` is set with custom `context_prompt_params` THEN the custom context template SHALL CONTINUE TO be used

3.5 WHEN the vector store search itself fails (e.g., store not found, embedding error) THEN the `file_search_call` SHALL CONTINUE TO report failure with appropriate error information

---

## Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type FileSearchRequest (query, vector_store_ids, vector_stores_config)
  OUTPUT: boolean

  // Returns true when vector_stores_config is None (not set in stack config)
  // and the code attempts to access template attributes on it
  RETURN X.vector_stores_config IS None
END FUNCTION
```

## Property Specification

```pascal
// Property: Fix Checking - file search works when vector_stores_config is None
FOR ALL X WHERE isBugCondition(X) DO
  result ← _execute_file_search_via_vector_store(X.query, X.file_search_tool)
  ASSERT result IS NOT an exception
  ASSERT result.content IS NOT NULL
  // Templates used should be VectorStoresConfig() defaults
END FOR
```

## Preservation Goal

```pascal
// Property: Preservation Checking - explicit vector_stores_config still used
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
  // When vector_stores_config is explicitly set, behavior is identical
  // Custom templates continue to be used
  // Annotation settings continue to be respected
END FOR
```
