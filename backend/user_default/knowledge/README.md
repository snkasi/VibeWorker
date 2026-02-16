# 知识库目录 (Knowledge Base)

将 PDF、Markdown、TXT 文件放置在此目录下，
系统会自动构建 RAG 索引用于知识检索。

## 支持的文件格式
- `.md` - Markdown
- `.txt` - 纯文本
- `.pdf` - PDF 文档

## 使用方法
1. 将文档放入此目录
2. 重启后端服务，或调用 `POST /api/knowledge/rebuild` 接口
3. Agent 将通过 `search_knowledge_base` 工具检索这些文档
