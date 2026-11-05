---
# Shown in the skill picker.
name: roundtrip
description: "Exercises every block the Skills editor reads: tables, task lists, HTML, code."
metadata:
  owner: isaac # keep
---

# Round trip

Plain text with AT&T, a -> arrow, `inline code`, **`bold code`** and a [link](https://example.com).
A soft
line break, and a\
hard one.

| Column | Wide column header | n |
|--------|:--------|--:|
| a | `x | y` | 1 |
| longer cell | b | 22 |

- [ ] open task
- [x] done task
  continued with a lazy line

1. first
2. second
   - nested *item*
   - another

<details>
<summary>HTML block</summary>

Inside HTML.
</details>

> A quote with **bold** and ~~strike~~.

```ts
const a = 1 < 2 && "&amp;";
```

See [the docs][docs] for more.

[docs]: https://example.com/docs "Docs"

---

Text &amp; entities &lt;kept&gt;.
