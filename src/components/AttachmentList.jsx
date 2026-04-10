import { fileId, formatBytes } from "../utils/debateHelpers.js";

export default function AttachmentList({ files, onRemove }) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="attachment-list">
      {files.map((file) => (
        <div className="attachment-chip" key={fileId(file)}>
          <div>
            <strong>{file.name}</strong>
            <span>{formatBytes(file.size)}</span>
          </div>
          <button type="button" onClick={() => onRemove(fileId(file))}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
