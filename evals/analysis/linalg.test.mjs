import { test } from "node:test";
import assert from "node:assert/strict";
import { transpose, multiply, identity, invert, jacobiEigenSymmetric, symmetricInverseSqrt } from "./linalg.mjs";

function approxEqualMatrix(A, B, tol = 1e-6) {
  assert.equal(A.length, B.length);
  for (let i = 0; i < A.length; i++) {
    assert.equal(A[i].length, B[i].length);
    for (let j = 0; j < A[i].length; j++) {
      assert.ok(Math.abs(A[i][j] - B[i][j]) < tol, `mismatch at [${i}][${j}]: ${A[i][j]} vs ${B[i][j]}`);
    }
  }
}

test("transpose", () => {
  assert.deepEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);
});

test("multiply: identity is a no-op", () => {
  const A = [[1, 2], [3, 4]];
  assert.deepEqual(multiply(A, identity(2)), A);
});

test("multiply: dimension mismatch throws", () => {
  assert.throws(() => multiply([[1, 2]], [[1, 2]]), /dimension mismatch/);
});

test("invert: 2x2", () => {
  const A = [[4, 7], [2, 6]];
  const inv = invert(A);
  approxEqualMatrix(multiply(A, inv), identity(2));
});

test("invert: singular matrix throws", () => {
  assert.throws(() => invert([[1, 2], [2, 4]]), /singular/);
});

test("jacobiEigenSymmetric: recovers eigenvalues of a diagonal matrix trivially", () => {
  const A = [[3, 0, 0], [0, 1, 0], [0, 0, 2]];
  const { eigenvalues } = jacobiEigenSymmetric(A);
  const sorted = [...eigenvalues].sort((a, b) => a - b);
  assert.deepEqual(sorted.map((v) => Math.round(v)), [1, 2, 3]);
});

test("jacobiEigenSymmetric: A = V diag(lambda) V^T reconstructs A", () => {
  const A = [[2, 1], [1, 2]];
  const { eigenvalues, eigenvectors } = jacobiEigenSymmetric(A);
  const D = identity(2).map((row, i) => row.map((_, j) => (i === j ? eigenvalues[i] : 0)));
  const reconstructed = multiply(multiply(eigenvectors, D), transpose(eigenvectors));
  approxEqualMatrix(reconstructed, A);
});

test("symmetricInverseSqrt: squares back to the inverse of the original (identity case)", () => {
  const M = identity(3);
  const sqrtInv = symmetricInverseSqrt(M);
  approxEqualMatrix(sqrtInv, identity(3));
});

test("symmetricInverseSqrt: M^(-1/2) * M^(-1/2) ~= M^-1 for a well-conditioned matrix", () => {
  const M = [[2, 0.3], [0.3, 1.5]];
  const sqrtInv = symmetricInverseSqrt(M);
  const shouldBeInverse = multiply(sqrtInv, sqrtInv);
  approxEqualMatrix(shouldBeInverse, invert(M), 1e-5);
});

// #46 QA MUST #4: fit.test.mjs's CR2 coverage was `vcov[i][i] > 0` only --
// nothing pinned symmetricInverseSqrt's actual identity A*M*A = I (which is
// exactly what CR2's A_g = (I - H_g)^(-1/2) adjustment relies on). This
// pins the eigen path directly, independent of fitR2()'s meat-accumulation
// loop.
test("symmetricInverseSqrt: A is symmetric and A * M * A ~= I (the identity CR2's A_g relies on)", () => {
  const M = [[3, 1, 0.4], [1, 2, 0.2], [0.4, 0.2, 1.5]];
  const A = symmetricInverseSqrt(M);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < i; j++) {
      assert.ok(Math.abs(A[i][j] - A[j][i]) < 1e-9, `A not symmetric at [${i}][${j}]`);
    }
  }
  const AMA = multiply(multiply(A, M), A);
  approxEqualMatrix(AMA, identity(3), 1e-5);
});
