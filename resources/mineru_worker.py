import json
import os
import shutil
import sys
import traceback
from pathlib import Path

PROTOCOL_VERSION = 1
PARSING_PROGRESS_START = 0.05
PARSING_PROGRESS_END = 0.9
PROCESSING_WINDOW_SIZE = 1

protocol_fd = os.dup(sys.stdout.fileno())
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
protocol = os.fdopen(protocol_fd, "w", buffering=1, encoding="utf-8")


def send(message):
    protocol.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")


def emit_stage(request_id, stage, progress):
    send({"event": "progress", "requestId": request_id, "stage": stage, "progress": progress})


def parsing_progress(current, total):
    if not total:
        return None
    ratio = max(0.0, min(float(current) / float(total), 1.0))
    return PARSING_PROGRESS_START + ratio * (PARSING_PROGRESS_END - PARSING_PROGRESS_START)


def create_progress_tqdm(base_tqdm, on_page_progress):
    class ReforaProgressTqdm(base_tqdm):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._refora_page_progress = kwargs.get("desc") == "Processing pages"

        def update(self, amount=1):
            result = super().update(amount)
            if self._refora_page_progress and self.total:
                on_page_progress(int(self.n), int(self.total))
            return result

    return ReforaProgressTqdm


def install_page_progress_hook(request_id, backend):
    from tqdm import tqdm as base_tqdm

    def on_page_progress(current, total):
        emit_stage(request_id, "parsing", parsing_progress(current, total))

    progress_tqdm = create_progress_tqdm(base_tqdm, on_page_progress)
    if backend == "pipeline":
        from mineru.backend.pipeline import pipeline_analyze

        pipeline_analyze.tqdm = progress_tqdm
    else:
        from mineru.backend.hybrid import hybrid_analyze

        hybrid_analyze.tqdm = progress_tqdm


def pdf_page_count(path):
    import pypdfium2 as pdfium

    try:
        document = pdfium.PdfDocument(str(path))
        try:
            return len(document)
        finally:
            document.close()
    except Exception:
        return None


def require_pdf(path_value):
    path = Path(path_value)
    if not path.is_absolute() or path.suffix.lower() != ".pdf":
        raise ValueError("Input must be an absolute PDF path")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Input must be a regular PDF file")
    return path


def require_output(path_value):
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("Output must be an absolute regular directory path")
    path.mkdir(parents=True, exist_ok=True)
    if any(path.iterdir()):
        raise ValueError("Output staging directory must be empty")
    return path


def first_file(root, suffix, preferred_suffix):
    matches = sorted(root.rglob(f"*{suffix}"))
    preferred = [path for path in matches if path.name.endswith(preferred_suffix)]
    selected = preferred[0] if preferred else (matches[0] if matches else None)
    if selected is None or selected.is_symlink() or not selected.is_file():
        raise RuntimeError(f"MinerU did not produce {preferred_suffix}")
    return selected


def normalize_output(output, stem):
    markdown_source = first_file(output, ".md", f"{stem}.md")
    content_source = first_file(output, ".json", "_content_list.json")
    middle_source = first_file(output, ".json", "_middle.json")
    source_directory = markdown_source.parent
    markdown = markdown_source.read_text(encoding="utf-8")
    content = json.loads(content_source.read_text(encoding="utf-8"))
    if not isinstance(content, list):
        raise RuntimeError("MinerU content list has an invalid shape")
    middle = json.loads(middle_source.read_text(encoding="utf-8"))
    temporary = output / ".normalized"
    temporary.mkdir(mode=0o700)
    (temporary / "document.md").write_text(markdown, encoding="utf-8")
    with (temporary / "blocks.jsonl").open("w", encoding="utf-8") as blocks:
        for item in content:
            blocks.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
    (temporary / "middle.json").write_text(
        json.dumps(middle, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    image_source = source_directory / "images"
    if image_source.is_dir() and not image_source.is_symlink():
        shutil.copytree(image_source, temporary / "assets")
    for child in list(output.iterdir()):
        if child != temporary:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    for child in list(temporary.iterdir()):
        shutil.move(str(child), output / child.name)
    temporary.rmdir()
    pdf_info = middle.get("pdf_info", []) if isinstance(middle, dict) else []
    return {
        "markdown": "document.md",
        "blocks": "blocks.jsonl",
        "middle": "middle.json",
        "assets": "assets" if (output / "assets").is_dir() else None,
        "pageCount": len(pdf_info) if isinstance(pdf_info, list) else None,
        "blockCount": len(content),
    }


def parse_document(request_id, params):
    input_path = require_pdf(params.get("inputPath", ""))
    output = require_output(params.get("outputPath", ""))
    profile = params.get("profile", "balanced")
    if profile not in {"compatible", "balanced", "quality"}:
        raise ValueError("Unsupported OCR profile")
    backend = "pipeline" if profile == "compatible" else "hybrid-engine"
    effort = "high" if profile == "quality" else "medium"
    image_analysis = profile == "quality"
    emit_stage(request_id, "loadingModels", None)
    from mineru.cli.common import do_parse, read_fn
    os.environ["MINERU_PROCESSING_WINDOW_SIZE"] = str(PROCESSING_WINDOW_SIZE)
    install_page_progress_hook(request_id, backend)
    page_count = pdf_page_count(input_path)
    emit_stage(request_id, "parsing", parsing_progress(0, page_count))
    do_parse(
        output_dir=str(output),
        pdf_file_names=[input_path.stem],
        pdf_bytes_list=[read_fn(input_path)],
        p_lang_list=[params.get("language", "ch")],
        backend=backend,
        parse_method="auto",
        formula_enable=True,
        table_enable=True,
        f_draw_layout_bbox=False,
        f_draw_span_bbox=False,
        f_dump_md=True,
        f_dump_middle_json=True,
        f_dump_model_output=False,
        f_dump_orig_pdf=False,
        f_dump_content_list=True,
        image_analysis=image_analysis,
        effort=effort,
    )
    emit_stage(request_id, "writingResults", 0.9)
    result = normalize_output(output, input_path.stem)
    emit_stage(request_id, "validating", 0.98)
    return result


def handle(message):
    request_id = message.get("id")
    method = message.get("method")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("Request ID is required")
    if method == "hello":
        from mineru.version import __version__
        return {"protocolVersion": PROTOCOL_VERSION, "mineruVersion": __version__}
    if method == "parse":
        return parse_document(request_id, message.get("params", {}))
    if method == "shutdown":
        return {"stopping": True}
    raise ValueError("Unsupported worker method")


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            result = handle(message)
            send({"id": request_id, "result": result})
            if message.get("method") == "shutdown":
                return
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({
                "id": request_id,
                "error": {
                    "code": error.__class__.__name__,
                    "message": str(error) or error.__class__.__name__,
                },
            })


if __name__ == "__main__":
    main()
