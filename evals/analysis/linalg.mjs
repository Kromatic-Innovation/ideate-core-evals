// linalg.mjs — the small, dependency-free matrix toolkit R2's CR2
// cluster-robust SEs need (fit.mjs). No npm dependency: matrices here are
// at most (params x params) or (cluster-size x cluster-size), both tiny for
// this study's design (a handful of arms, briefs as clusters), so a plain
// Gauss-Jordan inverse and a classic Jacobi eigensolver are both fast enough
// and simple enough to review by hand — which matters more than raw speed
// for code computing registered inferential statistics.

/** @param {number[][]} A */
export function transpose(A) {
  const rows = A.length, cols = A[0].length;
  const T = Array.from({ length: cols }, () => new Array(rows));
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) T[j][i] = A[i][j];
  return T;
}

/** @param {number[][]} A @param {number[][]} B */
export function multiply(A, B) {
  const n = A.length, m = A[0].length, p = B[0].length;
  if (B.length !== m) throw new Error(`multiply: dimension mismatch (${n}x${m}) * (${B.length}x${p})`);
  const C = Array.from({ length: n }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < p; j++) C[i][j] += a * B[k][j];
    }
  }
  return C;
}

/** @param {number} n */
export function identity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/** Column-vector helper: number[] -> (n x 1) matrix. */
export function asColumn(v) {
  return v.map((x) => [x]);
}

/** (n x 1) matrix -> number[]. */
export function fromColumn(m) {
  return m.map((row) => row[0]);
}

/**
 * Gauss-Jordan inverse with partial pivoting. Throws a named error on a
 * singular (or numerically indistinguishable-from-singular) matrix rather
 * than returning garbage — a design matrix that can't be inverted (e.g.
 * fewer clusters than parameters) is exactly the R2-failure condition that
 * should trigger a descent to R3, not a silently wrong SE.
 *
 * @param {number[][]} A  square matrix
 * @returns {number[][]}
 */
export function invert(A) {
  const n = A.length;
  if (n === 0 || A.some((row) => row.length !== n)) {
    throw new Error("invert: matrix must be square and non-empty");
  }
  // Augmented [A | I], operated on in place.
  const M = A.map((row, i) => [...row, ...identity(n)[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > pivotVal) {
        pivotRow = r;
        pivotVal = Math.abs(M[r][col]);
      }
    }
    if (pivotVal < 1e-12) {
      throw new Error("invert: matrix is singular (or numerically singular) — cannot invert");
    }
    if (pivotRow !== col) [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    const pivot = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * Classic cyclic Jacobi eigenvalue algorithm for a real SYMMETRIC matrix.
 * Returns eigenvalues and the matching eigenvectors as columns of V, such
 * that A ~= V * diag(eigenvalues) * V^T.
 *
 * @param {number[][]} Ain
 * @param {object} [opts]
 *   @param {number} [opts.maxSweeps=100]
 *   @param {number} [opts.tol=1e-12]
 * @returns {{eigenvalues: number[], eigenvectors: number[][]}}
 */
export function jacobiEigenSymmetric(Ain, opts = {}) {
  const n = Ain.length;
  const maxSweeps = opts.maxSweeps ?? 100;
  const tol = opts.tol ?? 1e-12;
  const A = Ain.map((row) => [...row]);
  let V = identity(n);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let i = 0; i < n; i++) {
          const aip = A[i][p], aiq = A[i][q];
          A[i][p] = c * aip - s * aiq;
          A[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = A[p][i], aqi = A[q][i];
          A[p][i] = c * api - s * aqi;
          A[q][i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = V[i][p], viq = V[i][q];
          V[i][p] = c * vip - s * viq;
          V[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  return { eigenvalues: A.map((row, i) => row[i]), eigenvectors: V };
}

/**
 * Symmetric matrix inverse-square-root via eigendecomposition:
 * M^(-1/2) = V * diag(1/sqrt(max(lambda_i, eps))) * V^T.
 * Clamps tiny/negative eigenvalues (from `I - H_g` being near-singular at
 * high leverage, or floating-point noise pushing a near-zero eigenvalue
 * slightly negative) to `eps` rather than letting them blow up or produce a
 * complex result — this is the standard CR2 numerical-safety convention
 * (MacKinnon & White's bias-reduced linearization assumes `I - H_g` is
 * positive semi-definite in theory; in floating point it needs this guard).
 *
 * @param {number[][]} M  symmetric
 * @param {number} [eps=1e-8]
 * @returns {number[][]}
 */
export function symmetricInverseSqrt(M, eps = 1e-8) {
  const { eigenvalues, eigenvectors: V } = jacobiEigenSymmetric(M);
  const n = eigenvalues.length;
  const Dinv = identity(n).map((row, i) => row.map((_, j) => (i === j ? 1 / Math.sqrt(Math.max(eigenvalues[i], eps)) : 0)));
  return multiply(multiply(V, Dinv), transpose(V));
}
