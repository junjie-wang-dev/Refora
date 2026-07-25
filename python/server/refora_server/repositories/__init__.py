from typing import Any, Callable

from refora_server.repositories.categories import createCategoriesRepository
from refora_server.repositories.documents import createDocumentsRepository
from refora_server.repositories.settings import create_settings_repository


class RepositoryDeps:
    def __init__(
        self,
        getLibraryFolder: Callable[[], str] | None = None,
        getSearchMode: Callable[[], str] | None = None,
    ) -> None:
        self.getLibraryFolder = getLibraryFolder or (lambda: "")
        self.getSearchMode = getSearchMode or (lambda: "trigram")


def create_repositories(db: Any, deps: RepositoryDeps | None = None) -> dict[str, Any]:
    if deps is None:
        deps = RepositoryDeps()
    documents = createDocumentsRepository(
        db,
        {
            "getLibraryFolder": deps.getLibraryFolder,
            "getSearchMode": deps.getSearchMode,
        },
    )
    categories = createCategoriesRepository(db)
    settings = create_settings_repository(db)
    return {
        "documents": documents,
        "categories": categories,
        "settings": settings,
    }