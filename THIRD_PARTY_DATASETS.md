# Third-Party Datasets

The MIT license in this repository applies to the runner code. Benchmark data
is downloaded from upstream projects at runtime and remains subject to its
upstream terms. The harness pins source revisions or content hashes and does
not commit a normalized dataset copy.

| Suite | Runtime source | Upstream terms | Notes |
| --- | --- | --- | --- |
| `browsecomp` | [OpenAI BrowseComp encrypted CSV](https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv) | See the [BrowseComp announcement](https://openai.com/index/browsecomp/) and [reference implementation](https://github.com/openai/simple-evals/blob/main/browsecomp_eval.py) | The upstream project asks users not to reveal decrypted examples publicly. |
| `dsqa` | [`google/deepsearchqa`](https://huggingface.co/datasets/google/deepsearchqa) | [Apache-2.0](https://huggingface.co/datasets/google/deepsearchqa) | The harness uses the official Hugging Face dataset revision pinned in code. |
| `widesearch` | [`ByteDance-Seed/WideSearch`](https://huggingface.co/datasets/ByteDance-Seed/WideSearch) | [CC0-1.0](https://huggingface.co/datasets/ByteDance-Seed/WideSearch/blob/main/LICENSE) | The Hugging Face dataset card currently labels the license as `other`; its checked-in license file contains CC0-1.0. |

Do not assume that this repository's MIT license supersedes upstream dataset
terms. Review those terms before redistributing cached files or benchmark
content.
