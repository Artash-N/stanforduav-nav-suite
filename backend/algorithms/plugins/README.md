# Writing algorithm plugins

If you are on the Navigation Team, this is your home.

To add a new algorithm:

1. Copy `_template.py` to a new file, e.g.:

   ```
   backend/algorithms/plugins/my_algo.py
   ```

2. Edit:
   - `ALGORITHM = AlgorithmSpec(...` (unique id + name)
   - `run(problem, options)`

3. Save the file.
   - In dev, uvicorn runs with `--reload`, so the backend restarts automatically.
   - In the GUI, click **Refresh algorithms**.

That's it.

Read `backend/algorithms/ALGORITHM_API.md` for the complete input/output spec.
