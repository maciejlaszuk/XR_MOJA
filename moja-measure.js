(function (global) {
  'use strict';

  var VERSION = '27';

  function createEngine(THREE, userOptions) {
    if (!THREE) throw new Error('MOJA MEASURE: THREE library is not available.');

    var options = Object.assign({
      surfaceSmoothAngleDeg: 14,
      maxSurfaceTriangles: 180000,
      minDistanceMaxTrianglesPerSet: 9000,
      minDistanceLeafSize: 10,
      minDistanceYieldEvery: 2400
    }, userOptions || {});

    var surfaceCache = new WeakMap();
    var temp = {
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      d: new THREE.Vector3(),
      e: new THREE.Vector3(),
      f: new THREE.Vector3(),
      ab: new THREE.Vector3(),
      ac: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      centroid: new THREE.Vector3(),
      closest: new THREE.Vector3(),
      closest2: new THREE.Vector3(),
      segA: new THREE.Vector3(),
      segB: new THREE.Vector3(),
      tri: new THREE.Triangle()
    };

    function finiteVector(value) {
      return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
    }

    function collectMeshes(objects) {
      var meshes = [];
      var seen = new Set();
      (Array.isArray(objects) ? objects : [objects]).forEach(function (object) {
        if (!object) return;
        if (object.isMesh && object.geometry && !seen.has(object)) {
          seen.add(object);
          meshes.push(object);
        }
        if (object.traverse) {
          object.traverse(function (child) {
            if (!child || !child.isMesh || !child.geometry || seen.has(child)) return;
            seen.add(child);
            meshes.push(child);
          });
        }
      });
      return meshes;
    }

    function triangleCount(geometry) {
      if (!geometry || !geometry.attributes || !geometry.attributes.position) return 0;
      return geometry.index
        ? Math.floor(geometry.index.count / 3)
        : Math.floor(geometry.attributes.position.count / 3);
    }

    function vertexIndex(geometry, triangleIndex, corner) {
      return geometry.index
        ? geometry.index.getX(triangleIndex * 3 + corner)
        : triangleIndex * 3 + corner;
    }

    function localVertex(geometry, triangleIndex, corner, output) {
      var position = geometry.attributes.position;
      output.fromBufferAttribute(position, vertexIndex(geometry, triangleIndex, corner));
      return output;
    }

    function worldVertex(object, geometry, triangleIndex, corner, output) {
      localVertex(geometry, triangleIndex, corner, output);
      return output.applyMatrix4(object.matrixWorld);
    }

    function triangleWorldData(object, geometry, triangleIndex, a, b, c) {
      object.updateMatrixWorld(true);
      worldVertex(object, geometry, triangleIndex, 0, a);
      worldVertex(object, geometry, triangleIndex, 1, b);
      worldVertex(object, geometry, triangleIndex, 2, c);
    }

    function triangleAreaAndNormal(a, b, c, normalOutput) {
      temp.ab.subVectors(b, a);
      temp.ac.subVectors(c, a);
      normalOutput.crossVectors(temp.ab, temp.ac);
      var doubledArea = normalOutput.length();
      if (doubledArea > 1e-18) normalOutput.multiplyScalar(1 / doubledArea);
      else normalOutput.set(0, 1, 0);
      return doubledArea * 0.5;
    }

    function geometryDiagonal(geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return 1;
      return geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
    }

    function positionKey(point, tolerance) {
      return Math.round(point.x / tolerance) + '|' +
        Math.round(point.y / tolerance) + '|' +
        Math.round(point.z / tolerance);
    }

    function edgeKey(a, b) {
      return a < b ? a + '>' + b : b + '>' + a;
    }

    function buildSurfaceData(geometry) {
      var cached = surfaceCache.get(geometry);
      if (cached) return cached;

      var count = triangleCount(geometry);
      if (!count || count > options.maxSurfaceTriangles) {
        cached = {supported: false, triangleCount: count};
        surfaceCache.set(geometry, cached);
        return cached;
      }

      var tolerance = Math.max(geometryDiagonal(geometry) * 1e-6, 1e-8);
      var normals = new Array(count);
      var edgeMap = new Map();
      var adjacency = new Array(count);
      var p0 = new THREE.Vector3();
      var p1 = new THREE.Vector3();
      var p2 = new THREE.Vector3();

      for (var index = 0; index < count; index += 1) {
        localVertex(geometry, index, 0, p0);
        localVertex(geometry, index, 1, p1);
        localVertex(geometry, index, 2, p2);
        normals[index] = new THREE.Vector3()
          .crossVectors(new THREE.Vector3().subVectors(p1, p0), new THREE.Vector3().subVectors(p2, p0));
        if (normals[index].lengthSq() > 1e-20) normals[index].normalize();
        else normals[index].set(0, 1, 0);
        adjacency[index] = [];

        var keys = [positionKey(p0, tolerance), positionKey(p1, tolerance), positionKey(p2, tolerance)];
        [[0, 1], [1, 2], [2, 0]].forEach(function (pair) {
          var key = edgeKey(keys[pair[0]], keys[pair[1]]);
          var list = edgeMap.get(key);
          if (!list) {
            list = [];
            edgeMap.set(key, list);
          }
          list.push(index);
        });
      }

      edgeMap.forEach(function (triangles) {
        if (triangles.length < 2) return;
        for (var i = 0; i < triangles.length; i += 1) {
          for (var j = i + 1; j < triangles.length; j += 1) {
            adjacency[triangles[i]].push(triangles[j]);
            adjacency[triangles[j]].push(triangles[i]);
          }
        }
      });

      cached = {
        supported: true,
        triangleCount: count,
        normals: normals,
        adjacency: adjacency
      };
      surfaceCache.set(geometry, cached);
      return cached;
    }

    function planarDimensionsForTriangles(object, geometry, triangleIndices, centroid, normal) {
      if (!object || !geometry || !triangleIndices || !triangleIndices.length || !centroid || !normal) {
        return {width: NaN, height: NaN, axisU: null, axisV: null};
      }

      var reference = Math.abs(normal.y) < 0.88
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
      var axisU = new THREE.Vector3().crossVectors(reference, normal).normalize();
      if (axisU.lengthSq() < 1e-12) axisU.set(1, 0, 0);
      var axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize();
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

      triangleIndices.forEach(function (triangleIndex) {
        triangleWorldData(object, geometry, triangleIndex, temp.a, temp.b, temp.c);
        [temp.a, temp.b, temp.c].forEach(function (point) {
          temp.d.copy(point).sub(centroid);
          var u = temp.d.dot(axisU);
          var v = temp.d.dot(axisV);
          minU = Math.min(minU, u); maxU = Math.max(maxU, u);
          minV = Math.min(minV, v); maxV = Math.max(maxV, v);
        });
      });

      return {
        width: Number.isFinite(minU) && Number.isFinite(maxU) ? maxU - minU : NaN,
        height: Number.isFinite(minV) && Number.isFinite(maxV) ? maxV - minV : NaN,
        axisU: axisU,
        axisV: axisV
      };
    }

    function surfacePatchFromIntersection(intersection, callOptions) {
      callOptions = callOptions || {};
      if (!intersection || !intersection.object || !intersection.object.geometry) return null;
      var object = intersection.object;
      var geometry = object.geometry;
      var count = triangleCount(geometry);
      var faceIndex = Number.isInteger(intersection.faceIndex)
        ? intersection.faceIndex
        : (intersection.face && Number.isInteger(intersection.face.a) ? Math.floor(intersection.face.a / 3) : 0);
      faceIndex = Math.max(0, Math.min(count - 1, faceIndex));

      var data = buildSurfaceData(geometry);
      if (!data.supported) {
        var fallback = surfaceAreaForObjects([object]);
        if (!fallback) return null;
        fallback.patch = false;
        fallback.approximate = true;
        fallback.reason = 'Mesh too large for connected-patch extraction; the full mesh area was calculated.';
        return fallback;
      }

      var maxAngleDeg = Number.isFinite(callOptions.smoothAngleDeg)
        ? callOptions.smoothAngleDeg
        : options.surfaceSmoothAngleDeg;
      var cosLimit = Math.cos(maxAngleDeg * Math.PI / 180);
      var visited = new Uint8Array(data.triangleCount);
      var queue = [faceIndex];
      visited[faceIndex] = 1;
      var selected = [];

      while (queue.length) {
        var current = queue.pop();
        selected.push(current);
        var currentNormal = data.normals[current];
        data.adjacency[current].forEach(function (next) {
          if (visited[next]) return;
          var dot = Math.abs(currentNormal.dot(data.normals[next]));
          if (dot < cosLimit) return;
          visited[next] = 1;
          queue.push(next);
        });
      }

      var area = 0;
      var weightedCentroid = new THREE.Vector3();
      var weightedNormal = new THREE.Vector3();
      object.updateMatrixWorld(true);
      selected.forEach(function (triangleIndex) {
        triangleWorldData(object, geometry, triangleIndex, temp.a, temp.b, temp.c);
        var triArea = triangleAreaAndNormal(temp.a, temp.b, temp.c, temp.normal);
        if (!(triArea > 0)) return;
        temp.centroid.copy(temp.a).add(temp.b).add(temp.c).multiplyScalar(1 / 3);
        weightedCentroid.addScaledVector(temp.centroid, triArea);
        weightedNormal.addScaledVector(temp.normal, triArea);
        area += triArea;
      });

      if (!(area > 0)) return null;
      weightedCentroid.multiplyScalar(1 / area);
      if (weightedNormal.lengthSq() > 1e-20) weightedNormal.normalize();
      else weightedNormal.set(0, 1, 0);

      var dimensions = planarDimensionsForTriangles(object, geometry, selected, weightedCentroid, weightedNormal);

      return {
        area: area,
        centroid: weightedCentroid,
        normal: weightedNormal,
        width: dimensions.width,
        height: dimensions.height,
        axisU: dimensions.axisU,
        axisV: dimensions.axisV,
        triangleIndices: selected.slice(),
        triangleCount: selected.length,
        totalTriangleCount: data.triangleCount,
        object: object,
        patch: true,
        approximate: false
      };
    }

    function surfaceAreaForObjects(objects) {
      var meshes = collectMeshes(objects);
      if (!meshes.length) return null;
      var totalArea = 0;
      var weightedCentroid = new THREE.Vector3();
      var weightedNormal = new THREE.Vector3();
      var totalTriangles = 0;

      meshes.forEach(function (object) {
        var geometry = object.geometry;
        var count = triangleCount(geometry);
        object.updateMatrixWorld(true);
        for (var triangleIndex = 0; triangleIndex < count; triangleIndex += 1) {
          triangleWorldData(object, geometry, triangleIndex, temp.a, temp.b, temp.c);
          var area = triangleAreaAndNormal(temp.a, temp.b, temp.c, temp.normal);
          if (!(area > 0)) continue;
          temp.centroid.copy(temp.a).add(temp.b).add(temp.c).multiplyScalar(1 / 3);
          weightedCentroid.addScaledVector(temp.centroid, area);
          weightedNormal.addScaledVector(temp.normal, area);
          totalArea += area;
          totalTriangles += 1;
        }
      });

      if (!(totalArea > 0)) return null;
      weightedCentroid.multiplyScalar(1 / totalArea);
      if (weightedNormal.lengthSq() > 1e-20) weightedNormal.normalize();
      else weightedNormal.set(0, 1, 0);
      var firstGeometry = meshes[0].geometry;
      var firstCount = triangleCount(firstGeometry);
      var firstIndices = [];
      for (var fallbackIndex = 0; fallbackIndex < firstCount; fallbackIndex += 1) firstIndices.push(fallbackIndex);
      var fallbackDimensions = planarDimensionsForTriangles(meshes[0], firstGeometry, firstIndices, weightedCentroid, weightedNormal);
      return {
        area: totalArea,
        centroid: weightedCentroid,
        normal: weightedNormal,
        width: fallbackDimensions.width,
        height: fallbackDimensions.height,
        axisU: fallbackDimensions.axisU,
        axisV: fallbackDimensions.axisV,
        triangleIndices: meshes.length === 1 ? firstIndices : null,
        triangleCount: totalTriangles,
        totalTriangleCount: totalTriangles,
        object: meshes[0],
        patch: false,
        approximate: false
      };
    }

    function countTrianglesInMeshes(meshes) {
      var total = 0;
      meshes.forEach(function (mesh) { total += triangleCount(mesh.geometry); });
      return total;
    }

    function createTriangleData(a, b, c, sourceObject) {
      var centroid = new THREE.Vector3().copy(a).add(b).add(c).multiplyScalar(1 / 3);
      var min = new THREE.Vector3(
        Math.min(a.x, b.x, c.x),
        Math.min(a.y, b.y, c.y),
        Math.min(a.z, b.z, c.z)
      );
      var max = new THREE.Vector3(
        Math.max(a.x, b.x, c.x),
        Math.max(a.y, b.y, c.y),
        Math.max(a.z, b.z, c.z)
      );
      return {
        a: a.clone(),
        b: b.clone(),
        c: c.clone(),
        centroid: centroid,
        min: min,
        max: max,
        sourceObject: sourceObject
      };
    }

    function extractTriangles(objects, maxTriangles) {
      var meshes = collectMeshes(objects).filter(function (mesh) { return mesh.visible !== false; });
      var originalCount = countTrianglesInMeshes(meshes);
      var stride = Math.max(1, Math.ceil(originalCount / Math.max(1, maxTriangles)));
      var triangles = [];
      var globalIndex = 0;

      meshes.forEach(function (object) {
        var geometry = object.geometry;
        var count = triangleCount(geometry);
        object.updateMatrixWorld(true);
        for (var triangleIndex = 0; triangleIndex < count; triangleIndex += 1) {
          var use = (globalIndex % stride) === 0;
          globalIndex += 1;
          if (!use) continue;
          triangleWorldData(object, geometry, triangleIndex, temp.a, temp.b, temp.c);
          triangles.push(createTriangleData(temp.a, temp.b, temp.c, object));
        }
      });

      return {
        triangles: triangles,
        originalCount: originalCount,
        usedCount: triangles.length,
        approximate: stride > 1,
        stride: stride
      };
    }

    function unionBounds(triangles, indexes) {
      var min = new THREE.Vector3(Infinity, Infinity, Infinity);
      var max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      indexes.forEach(function (index) {
        var triangle = triangles[index];
        min.min(triangle.min);
        max.max(triangle.max);
      });
      return {min: min, max: max};
    }

    function buildBvh(triangles, indexes, leafSize) {
      var bounds = unionBounds(triangles, indexes);
      if (indexes.length <= leafSize) {
        return {min: bounds.min, max: bounds.max, indexes: indexes, count: indexes.length};
      }

      var extent = new THREE.Vector3().subVectors(bounds.max, bounds.min);
      var axis = extent.x >= extent.y && extent.x >= extent.z ? 'x' : (extent.y >= extent.z ? 'y' : 'z');
      indexes.sort(function (left, right) {
        return triangles[left].centroid[axis] - triangles[right].centroid[axis];
      });
      var middle = Math.floor(indexes.length / 2);
      var leftIndexes = indexes.slice(0, middle);
      var rightIndexes = indexes.slice(middle);
      if (!leftIndexes.length || !rightIndexes.length) {
        return {min: bounds.min, max: bounds.max, indexes: indexes, count: indexes.length};
      }
      var left = buildBvh(triangles, leftIndexes, leafSize);
      var right = buildBvh(triangles, rightIndexes, leafSize);
      return {
        min: bounds.min,
        max: bounds.max,
        left: left,
        right: right,
        count: indexes.length
      };
    }

    function boxDistanceSquared(a, b) {
      var dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
      var dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
      var dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
      return dx * dx + dy * dy + dz * dz;
    }

    function segmentSegmentClosest(p1, q1, p2, q2, out1, out2) {
      var d1 = new THREE.Vector3().subVectors(q1, p1);
      var d2 = new THREE.Vector3().subVectors(q2, p2);
      var r = new THREE.Vector3().subVectors(p1, p2);
      var a = d1.dot(d1);
      var e = d2.dot(d2);
      var f = d2.dot(r);
      var s;
      var t;
      var epsilon = 1e-14;

      if (a <= epsilon && e <= epsilon) {
        out1.copy(p1);
        out2.copy(p2);
        return out1.distanceToSquared(out2);
      }
      if (a <= epsilon) {
        s = 0;
        t = Math.max(0, Math.min(1, f / e));
      } else {
        var c = d1.dot(r);
        if (e <= epsilon) {
          t = 0;
          s = Math.max(0, Math.min(1, -c / a));
        } else {
          var b = d1.dot(d2);
          var denominator = a * e - b * b;
          s = denominator !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denominator)) : 0;
          t = (b * s + f) / e;
          if (t < 0) {
            t = 0;
            s = Math.max(0, Math.min(1, -c / a));
          } else if (t > 1) {
            t = 1;
            s = Math.max(0, Math.min(1, (b - c) / a));
          }
        }
      }

      out1.copy(d1).multiplyScalar(s).add(p1);
      out2.copy(d2).multiplyScalar(t).add(p2);
      return out1.distanceToSquared(out2);
    }

    function updateBest(best, pointA, pointB, distanceSquared, objectA, objectB) {
      if (!(distanceSquared < best.distanceSquared)) return;
      best.distanceSquared = distanceSquared;
      best.pointA.copy(pointA);
      best.pointB.copy(pointB);
      best.objectA = objectA;
      best.objectB = objectB;
    }

    function triangleTriangleDistance(triangleA, triangleB, best) {
      var verticesA = [triangleA.a, triangleA.b, triangleA.c];
      var verticesB = [triangleB.a, triangleB.b, triangleB.c];
      var triB = temp.tri.set(triangleB.a, triangleB.b, triangleB.c);
      verticesA.forEach(function (vertex) {
        triB.closestPointToPoint(vertex, temp.closest);
        updateBest(best, vertex, temp.closest, vertex.distanceToSquared(temp.closest), triangleA.sourceObject, triangleB.sourceObject);
      });
      var triA = temp.tri.set(triangleA.a, triangleA.b, triangleA.c);
      verticesB.forEach(function (vertex) {
        triA.closestPointToPoint(vertex, temp.closest);
        updateBest(best, temp.closest, vertex, vertex.distanceToSquared(temp.closest), triangleA.sourceObject, triangleB.sourceObject);
      });

      var edgesA = [[triangleA.a, triangleA.b], [triangleA.b, triangleA.c], [triangleA.c, triangleA.a]];
      var edgesB = [[triangleB.a, triangleB.b], [triangleB.b, triangleB.c], [triangleB.c, triangleB.a]];
      edgesA.forEach(function (edgeA) {
        edgesB.forEach(function (edgeB) {
          var distanceSquared = segmentSegmentClosest(edgeA[0], edgeA[1], edgeB[0], edgeB[1], temp.segA, temp.segB);
          updateBest(best, temp.segA, temp.segB, distanceSquared, triangleA.sourceObject, triangleB.sourceObject);
        });
      });
    }

    function delayFrame() {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    async function closestDistanceBetweenObjectSets(objectsA, objectsB, callOptions) {
      callOptions = callOptions || {};
      var maxTriangles = Number.isFinite(callOptions.maxTrianglesPerSet)
        ? Math.max(200, Math.floor(callOptions.maxTrianglesPerSet))
        : options.minDistanceMaxTrianglesPerSet;
      var leafSize = Number.isFinite(callOptions.leafSize)
        ? Math.max(4, Math.floor(callOptions.leafSize))
        : options.minDistanceLeafSize;
      var yieldEvery = Number.isFinite(callOptions.yieldEvery)
        ? Math.max(100, Math.floor(callOptions.yieldEvery))
        : options.minDistanceYieldEvery;
      var progress = typeof callOptions.onProgress === 'function' ? callOptions.onProgress : null;

      var setA = new Set(collectMeshes(objectsA));
      var filteredB = collectMeshes(objectsB).filter(function (mesh) { return !setA.has(mesh); });
      var filteredA = Array.from(setA);
      if (!filteredA.length || !filteredB.length) return null;

      var extractedA = extractTriangles(filteredA, maxTriangles);
      var extractedB = extractTriangles(filteredB, maxTriangles);
      if (!extractedA.triangles.length || !extractedB.triangles.length) return null;

      var indexesA = extractedA.triangles.map(function (_, index) { return index; });
      var indexesB = extractedB.triangles.map(function (_, index) { return index; });
      var bvhA = buildBvh(extractedA.triangles, indexesA, leafSize);
      var bvhB = buildBvh(extractedB.triangles, indexesB, leafSize);
      var best = {
        distanceSquared: Infinity,
        pointA: new THREE.Vector3(),
        pointB: new THREE.Vector3(),
        objectA: null,
        objectB: null
      };
      var stack = [{a: bvhA, b: bvhB}];
      var operations = 0;
      var visitedPairs = 0;

      while (stack.length) {
        var pair = stack.pop();
        visitedPairs += 1;
        if (boxDistanceSquared(pair.a, pair.b) >= best.distanceSquared) continue;

        var leafA = Array.isArray(pair.a.indexes);
        var leafB = Array.isArray(pair.b.indexes);
        if (leafA && leafB) {
          for (var ia = 0; ia < pair.a.indexes.length; ia += 1) {
            for (var ib = 0; ib < pair.b.indexes.length; ib += 1) {
              triangleTriangleDistance(
                extractedA.triangles[pair.a.indexes[ia]],
                extractedB.triangles[pair.b.indexes[ib]],
                best
              );
              operations += 1;
              if (best.distanceSquared <= 1e-18) break;
              if (operations % yieldEvery === 0) {
                if (progress) progress({operations: operations, pending: stack.length, bestDistance: Math.sqrt(best.distanceSquared)});
                await delayFrame();
              }
            }
            if (best.distanceSquared <= 1e-18) break;
          }
          if (best.distanceSquared <= 1e-18) break;
          continue;
        }

        var candidates = [];
        if (leafA || (!leafB && pair.b.count > pair.a.count)) {
          candidates.push({a: pair.a, b: pair.b.left});
          candidates.push({a: pair.a, b: pair.b.right});
        } else {
          candidates.push({a: pair.a.left, b: pair.b});
          candidates.push({a: pair.a.right, b: pair.b});
        }
        candidates.sort(function (left, right) {
          return boxDistanceSquared(right.a, right.b) - boxDistanceSquared(left.a, left.b);
        });
        candidates.forEach(function (candidate) {
          if (candidate.a && candidate.b && boxDistanceSquared(candidate.a, candidate.b) < best.distanceSquared) stack.push(candidate);
        });
      }

      if (!Number.isFinite(best.distanceSquared)) return null;
      return {
        distance: Math.sqrt(Math.max(0, best.distanceSquared)),
        pointA: best.pointA.clone(),
        pointB: best.pointB.clone(),
        objectA: best.objectA,
        objectB: best.objectB,
        approximate: extractedA.approximate || extractedB.approximate,
        sourceTrianglesA: extractedA.originalCount,
        sourceTrianglesB: extractedB.originalCount,
        usedTrianglesA: extractedA.usedCount,
        usedTrianglesB: extractedB.usedCount,
        operations: operations,
        visitedPairs: visitedPairs
      };
    }

    function angleDegrees(a, vertex, b) {
      if (!finiteVector(a) || !finiteVector(vertex) || !finiteVector(b)) return NaN;
      temp.ab.subVectors(a, vertex);
      temp.ac.subVectors(b, vertex);
      if (temp.ab.lengthSq() < 1e-20 || temp.ac.lengthSq() < 1e-20) return NaN;
      return THREE.MathUtils.radToDeg(temp.ab.angleTo(temp.ac));
    }

    function modelCoordinates(worldPoint, root, output) {
      output = output || new THREE.Vector3();
      output.copy(worldPoint);
      if (root) {
        root.updateMatrixWorld(true);
        root.worldToLocal(output);
      }
      return output;
    }

    return {
      version: VERSION,
      collectMeshes: collectMeshes,
      surfacePatchFromIntersection: surfacePatchFromIntersection,
      surfaceAreaForObjects: surfaceAreaForObjects,
      closestDistanceBetweenObjectSets: closestDistanceBetweenObjectSets,
      angleDegrees: angleDegrees,
      modelCoordinates: modelCoordinates
    };
  }

  global.MOJA_MEASURE = {
    version: VERSION,
    createEngine: createEngine
  };
})(typeof window !== 'undefined' ? window : this);
