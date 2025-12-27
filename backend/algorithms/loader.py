from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from typing import Callable, Dict, List

from .types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions


@dataclass
class LoadedAlgorithm:
    spec: AlgorithmSpec
    run: Callable[[GridProblem, RunOptions], AlgorithmResult]


def load_plugins() -> Dict[str, LoadedAlgorithm]:
    """Discover and import all algorithms from backend/algorithms/plugins.

    Each plugin module must define:
      - ALGORITHM: AlgorithmSpec
      - run(problem: GridProblem, options: RunOptions) -> AlgorithmResult

    Returns
    -------
    dict mapping algorithm_id -> LoadedAlgorithm
    """

    registry: Dict[str, LoadedAlgorithm] = {}

    # loader.py lives in the `backend.algorithms` package.
    # Plugins live in `backend.algorithms.plugins`.
    package_name = __package__ + '.plugins'
    package = importlib.import_module(package_name)

    for m in pkgutil.iter_modules(package.__path__):
        if m.name.startswith('_'):
            continue
        module = importlib.import_module(f"{package_name}.{m.name}")
        spec = getattr(module, 'ALGORITHM', None)
        run_fn = getattr(module, 'run', None)
        if spec is None or run_fn is None:
            continue
        if not isinstance(spec, AlgorithmSpec):
            raise TypeError(f"Plugin {m.name} ALGORITHM must be AlgorithmSpec")
        if spec.id in registry:
            raise ValueError(f"Duplicate algorithm id: {spec.id}")
        registry[spec.id] = LoadedAlgorithm(spec=spec, run=run_fn)

    return registry


def list_algorithms(registry: Dict[str, LoadedAlgorithm]) -> List[AlgorithmSpec]:
    return [registry[k].spec for k in sorted(registry.keys())]
