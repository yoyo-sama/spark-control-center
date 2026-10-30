// Run: node --test backend/benchtargets.test.js
const test = require('node:test');
const assert = require('node:assert');
const { classifyContainer, parseModels, sortTargets } = require('./benchtargets');

test('classifyContainer recognises inference servers by image or name', () => {
  const cases = [
    [{ name: 'vllm-qwen', image: 'nvcr.io/nvidia/vllm:25.09-py3' }, 'vllm'],
    [{ name: 'llm', image: 'vllm/vllm-openai:latest' }, 'vllm'],
    [{ name: 'sglang', image: 'lmsysorg/sglang:spark' }, 'sglang'],
    [{ name: 'ollama-api', image: 'ollama/ollama:latest' }, 'ollama'],
    [{ name: 'trt', image: 'nvcr.io/nvidia/tensorrt-llm/release:1.0' }, 'trtllm'],
    [{ name: 'llama', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' }, 'llamacpp'],
    [{ name: 'tgi', image: 'ghcr.io/huggingface/text-generation-inference:3' }, 'tgi'],
    [{ name: 'llama31', image: 'nvcr.io/nim/meta/llama-3.1-8b-instruct:latest' }, 'nim'],
    [{ name: 'comfyui', image: 'mmartial/comfyui-nvidia-docker:latest' }, 'openai'],
  ];
  for (const [c, kind] of cases) assert.strictEqual(classifyContainer(c).kind, kind, c.image);
});

test('classifyContainer does not take a substring of a word for a kind', () => {
  assert.strictEqual(classifyContainer({ name: 'minimal-app', image: 'nginx:alpine' }).kind, 'openai');
  assert.strictEqual(classifyContainer({ name: 'stgi', image: 'x' }).kind, 'openai');
});

test('parseModels reads the OpenAI /v1/models shape served by vLLM and Ollama', () => {
  assert.deepStrictEqual(parseModels({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model' }] }), ['Qwen/Qwen3-8B']);
  assert.deepStrictEqual(parseModels({ object: 'list', data: [{ id: 'llama3.2:1b' }, { id: 'gpt-oss:20b' }, { nope: 1 }] }), ['llama3.2:1b', 'gpt-oss:20b']);
  assert.strictEqual(parseModels({ models: [{ name: 'x' }] }), null, 'Ollama /api/tags is not /v1/models');
  assert.strictEqual(parseModels(null), null);
});

test('sortTargets: reachable first, then known servers, then by name and port', () => {
  const t = (containerName, kind, reachable, port) => ({ containerName, kind, reachable, port });
  const sorted = sortTargets([t('b', 'openai', true, 1), t('a', 'vllm', false, 1), t('c', 'ollama', true, 2), t('c', 'ollama', true, 1)]);
  assert.deepStrictEqual(sorted.map((x) => `${x.containerName}:${x.port}`), ['c:1', 'c:2', 'b:1', 'a:1']);
});
