(function (global) {
  'use strict';

  var VERSION = '19';

  function createEngine(THREE, userOptions) {
    if (!THREE) throw new Error('MOJA SNAP: brak biblioteki THREE.');

    var options = Object.assign({
      featureAngleDeg: 18,
      maxLoopSegments: 120000,
      maxSegmentsPerSnap: 160000,
      maxObjectsPerSnap: 8,
      maxCircleCandidateObjects: 24,
      maxSearchObjects: 12000,
      maxAngleRad: 0.016,
      circleMinVertices: 6,
      circleMaxVertices: 720
    }, userOptions || {});

    var geometryCache = new WeakMap();

    var temp = {
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      d: new THREE.Vector3(),
      e: new THREE.Vector3(),
      f: new THREE.Vector3(),
      pointOnRay: new THREE.Vector3(),
      pointOnSegment: new THREE.Vector3(),
      toPoint: new THREE.Vector3(),
      closest: new THREE.Vector3(),
      midpoint: new THREE.Vector3(),
      inverse: new THREE.Matrix4()
    };

    function finiteVector(vector) {
      return vector && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
    }

    function geometryDiagonal(geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return 1;
      return geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
    }

    function pointKey(point, tolerance) {
      return Math.round(point.x / tolerance) + '|' +
             Math.round(point.y / tolerance) + '|' +
             Math.round(point.z / tolerance);
    }

    function solve3x3(matrix, vector) {
      var a = [
        [matrix[0][0], matrix[0][1], matrix[0][2], vector[0]],
        [matrix[1][0], matrix[1][1], matrix[1][2], vector[1]],
        [matrix[2][0], matrix[2][1], matrix[2][2], vector[2]]
      ];

      for (var column = 0; column < 3; column += 1) {
        var pivot = column;
        for (var row = column + 1; row < 3; row += 1) {
          if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
        }
        if (Math.abs(a[pivot][column]) < 1e-14) return null;
        if (pivot !== column) {
          var swap = a[pivot];
          a[pivot] = a[column];
          a[column] = swap;
        }
        var divisor = a[column][column];
        for (var c = column; c < 4; c += 1) a[column][c] /= divisor;
        for (var r = 0; r < 3; r += 1) {
          if (r === column) continue;
          var factor = a[r][column];
          for (var cc = column; cc < 4; cc += 1) a[r][cc] -= factor * a[column][cc];
        }
      }

      return [a[0][3], a[1][3], a[2][3]];
    }

    function fitCircle(points, diagonal) {
      if (!points || points.length < options.circleMinVertices) return null;

      var centroid = new THREE.Vector3();
      points.forEach(function (point) { centroid.add(point); });
      centroid.multiplyScalar(1 / points.length);

      var normal = new THREE.Vector3();
      for (var index = 0; index < points.length; index += 1) {
        var current = points[index];
        var next = points[(index + 1) % points.length];
        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
      }
      if (normal.lengthSq() < 1e-18) return null;
      normal.normalize();

      var axisU = null;
      for (var i = 0; i < points.length; i += 1) {
        var candidate = points[i].clone().sub(centroid);
        candidate.addScaledVector(normal, -candidate.dot(normal));
        if (candidate.lengthSq() > 1e-16) {
          axisU = candidate.normalize();
          break;
        }
      }
      if (!axisU) return null;
      var axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize();

      var coords = [];
      var maxPlaneDeviation = 0;
      points.forEach(function (point) {
        var relative = point.clone().sub(centroid);
        maxPlaneDeviation = Math.max(maxPlaneDeviation, Math.abs(relative.dot(normal)));
        coords.push({x: relative.dot(axisU), y: relative.dot(axisV)});
      });

      var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      var sb = 0, sxb = 0, syb = 0;
      coords.forEach(function (point) {
        var q = point.x * point.x + point.y * point.y;
        sx += point.x;
        sy += point.y;
        sxx += point.x * point.x;
        syy += point.y * point.y;
        sxy += point.x * point.y;
        sb += -q;
        sxb += -point.x * q;
        syb += -point.y * q;
      });

      var solution = solve3x3(
        [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, coords.length]],
        [sxb, syb, sb]
      );
      if (!solution) return null;

      var centerX = -solution[0] * 0.5;
      var centerY = -solution[1] * 0.5;
      var radiusSquared = centerX * centerX + centerY * centerY - solution[2];
      if (!(radiusSquared > 0)) return null;
      var radius = Math.sqrt(radiusSquared);
      if (radius < Math.max(diagonal * 1e-6, 1e-8)) return null;

      var radialError = 0;
      var perimeter = 0;
      coords.forEach(function (point, idx) {
        var dx = point.x - centerX;
        var dy = point.y - centerY;
        radialError = Math.max(radialError, Math.abs(Math.sqrt(dx * dx + dy * dy) - radius));
        var next = coords[(idx + 1) % coords.length];
        perimeter += Math.hypot(next.x - point.x, next.y - point.y);
      });

      var planeTolerance = Math.max(diagonal * 2e-5, radius * 0.02);
      if (maxPlaneDeviation > planeTolerance) return null;
      if (radialError / radius > 0.045) return null;
      var perimeterRatio = perimeter / (2 * Math.PI * radius);
      if (perimeterRatio < 0.82 || perimeterRatio > 1.18) return null;

      var center = centroid.clone()
        .addScaledVector(axisU, centerX)
        .addScaledVector(axisV, centerY);

      return {
        center: center,
        normal: normal,
        radius: radius,
        vertices: points.length,
        error: radialError / radius
      };
    }

    function buildFeatureData(geometry) {
      if (!geometry || !geometry.attributes || !geometry.attributes.position) {
        return {diagonal: 1, segments: [], circles: []};
      }

      var cached = geometryCache.get(geometry);
      if (cached) return cached;

      var diagonal = geometryDiagonal(geometry);
      var tolerance = Math.max(diagonal * 1e-6, 1e-8);
      var segments = [];
      var circles = [];
      var segmentKeys = new Set();
      var edgeGeometry = null;

      try {
        edgeGeometry = new THREE.EdgesGeometry(geometry, options.featureAngleDeg);
        var position = edgeGeometry.getAttribute('position');
        if (position) {
          for (var index = 0; index + 1 < position.count; index += 2) {
            var a = new THREE.Vector3().fromBufferAttribute(position, index);
            var b = new THREE.Vector3().fromBufferAttribute(position, index + 1);
            if (a.distanceToSquared(b) < tolerance * tolerance) continue;
            var keyA = pointKey(a, tolerance);
            var keyB = pointKey(b, tolerance);
            var edgeKey = keyA < keyB ? keyA + '>' + keyB : keyB + '>' + keyA;
            if (segmentKeys.has(edgeKey)) continue;
            segmentKeys.add(edgeKey);
            segments.push({a: a, b: b, keyA: keyA, keyB: keyB});
          }
        }
      } catch (error) {
        segments = [];
      } finally {
        if (edgeGeometry && edgeGeometry.dispose) edgeGeometry.dispose();
      }

      if (segments.length <= options.maxLoopSegments) {
        var nodes = new Map();
        function getNode(key, point) {
          var node = nodes.get(key);
          if (!node) {
            node = {key: key, point: point.clone(), count: 1, neighbours: new Set()};
            nodes.set(key, node);
          } else {
            node.point.multiplyScalar(node.count).add(point).multiplyScalar(1 / (node.count + 1));
            node.count += 1;
          }
          return node;
        }

        segments.forEach(function (segment) {
          var nodeA = getNode(segment.keyA, segment.a);
          var nodeB = getNode(segment.keyB, segment.b);
          nodeA.neighbours.add(segment.keyB);
          nodeB.neighbours.add(segment.keyA);
        });

        // W modelach CAD okrąg bywa połączony z drugim okręgiem jedną
        // krawędzią szwu cylindra. Taka krawędź łączy zwykle dwa węzły o
        // stopniu > 2. Pomijamy ją wyłącznie podczas wykrywania pętli; nadal
        // pozostaje dostępna jako zwykła krawędź do snapowania.
        nodes.forEach(function (node) { node.circleNeighbours = new Set(); });
        segments.forEach(function (segment) {
          var nodeA = nodes.get(segment.keyA);
          var nodeB = nodes.get(segment.keyB);
          if (!nodeA || !nodeB) return;
          if (nodeA.neighbours.size > 2 && nodeB.neighbours.size > 2) return;
          nodeA.circleNeighbours.add(segment.keyB);
          nodeB.circleNeighbours.add(segment.keyA);
        });

        var visited = new Set();
        nodes.forEach(function (startNode, startKey) {
          if (visited.has(startKey) || startNode.circleNeighbours.size === 0) return;
          var stack = [startKey];
          var component = [];
          visited.add(startKey);
          while (stack.length) {
            var key = stack.pop();
            component.push(key);
            var node = nodes.get(key);
            if (!node) continue;
            node.circleNeighbours.forEach(function (nextKey) {
              if (!visited.has(nextKey)) {
                visited.add(nextKey);
                stack.push(nextKey);
              }
            });
          }

          if (component.length < options.circleMinVertices || component.length > options.circleMaxVertices) return;
          if (!component.every(function (key) { return nodes.get(key).circleNeighbours.size === 2; })) return;

          var ordered = [];
          var start = component[0];
          var previous = null;
          var current = start;
          var safety = component.length + 2;
          while (safety-- > 0) {
            ordered.push(nodes.get(current).point.clone());
            var neighbours = Array.from(nodes.get(current).circleNeighbours);
            var next = neighbours[0] === previous ? neighbours[1] : neighbours[0];
            previous = current;
            current = next;
            if (current === start) break;
            if (!current || ordered.length > component.length) return;
          }
          if (current !== start || ordered.length !== component.length) return;

          var fitted = fitCircle(ordered, diagonal);
          if (!fitted) return;

          var duplicate = circles.some(function (circle) {
            return circle.center.distanceTo(fitted.center) <= Math.max(tolerance * 8, fitted.radius * 0.01) &&
                   Math.abs(circle.radius - fitted.radius) <= Math.max(tolerance * 8, fitted.radius * 0.02);
          });
          if (!duplicate) circles.push(fitted);
        });
      }

      cached = {diagonal: diagonal, segments: segments, circles: circles};
      geometryCache.set(geometry, cached);
      return cached;
    }

    function rayMetric(ray, point) {
      if (!ray || !finiteVector(point)) return null;
      temp.toPoint.subVectors(point, ray.origin);
      var along = temp.toPoint.dot(ray.direction);
      if (!(along > 0)) return null;
      ray.at(along, temp.closest);
      var perpendicular = temp.closest.distanceTo(point);
      var angle = Math.atan2(perpendicular, Math.max(along, 1e-9));
      return {along: along, perpendicular: perpendicular, angle: angle};
    }

    function worldVertex(object, position, index, output) {
      output.fromBufferAttribute(position, index);
      return output.applyMatrix4(object.matrixWorld);
    }

    function snapFromIntersections(intersections, ray, callOptions) {
      callOptions = callOptions || {};
      var maxAngle = Number.isFinite(callOptions.maxAngleRad) ? callOptions.maxAngleRad : options.maxAngleRad;
      var hits = (Array.isArray(intersections) ? intersections : [intersections]).filter(function (hit) {
        return hit && hit.object && hit.object.geometry && finiteVector(hit.point);
      });
      if (!ray) return null;

      var filters = Object.assign({
        vertex: true,
        center: true,
        midpoint: true,
        edge: true,
        perpendicular: true,
        surface: true
      }, callOptions.filters || {});
      var snappingEnabled = callOptions.enabled !== false;
      var basePoint = finiteVector(callOptions.basePoint) ? callOptions.basePoint : null;
      var hasSurfaceHit = hits.length > 0;
      var referenceDistance = hasSurfaceHit ? Number(hits[0].distance) : Number(callOptions.referenceDistance);
      if (!Number.isFinite(referenceDistance) && hasSurfaceHit) referenceDistance = ray.origin.distanceTo(hits[0].point);
      if (!Number.isFinite(referenceDistance)) referenceDistance = 10;
      referenceDistance = Math.max(referenceDistance, 0.05);

      function surfaceResult() {
        if (!hasSurfaceHit) return null;
        return {
          point: hits[0].point.clone(),
          object: hits[0].object,
          kind: 'surface',
          label: snappingEnabled ? 'PUNKT POWIERZCHNI' : 'SNAP WYŁĄCZONY / PUNKT DOWOLNY',
          snapped: false,
          angle: 0,
          sourceIntersection: hits[0]
        };
      }

      if (!snappingEnabled) return surfaceResult();

      var best = hasSurfaceHit && filters.surface ? Object.assign(surfaceResult(), {score: 999}) : null;

      var penalties = {
        vertex: 0.00,
        perpendicular: 0.018,
        center: 0.035,
        midpoint: 0.070,
        edge: 0.110,
        meshVertex: 0.135,
        meshMidpoint: 0.165,
        meshEdge: 0.190
      };

      function filterAllows(kind) {
        if (kind === 'vertex') return filters.vertex !== false;
        if (kind === 'center') return filters.center !== false;
        if (kind === 'midpoint') return filters.midpoint !== false;
        if (kind === 'edge') return filters.edge !== false;
        if (kind === 'perpendicular') return filters.perpendicular !== false;
        if (kind === 'surface') return filters.surface !== false;
        return true;
      }

      function consider(point, object, kind, label, sourceIntersection, penalty, acceptanceMultiplier) {
        if (!filterAllows(kind)) return;
        var metric = rayMetric(ray, point);
        if (!metric) return;
        var limit = maxAngle * (acceptanceMultiplier || 1);
        if (metric.angle > limit) return;
        var depthDelta = hasSurfaceHit ? Math.abs(metric.along - referenceDistance) / referenceDistance : 0;
        var nearPreference = hasSurfaceHit
          ? Math.min(metric.along / referenceDistance, 4) * 0.006
          : Math.min(metric.along, 100) * 0.0002;
        var score = metric.angle / Math.max(maxAngle, 1e-8) + penalty + Math.min(depthDelta, 6) * 0.018 + nearPreference;
        if (!best || score < best.score) {
          best = {
            point: point.clone(),
            object: object,
            kind: kind,
            label: label,
            snapped: true,
            score: score,
            angle: metric.angle,
            sourceIntersection: sourceIntersection || null
          };
        }
      }

      function considerPerpendicular(a, b, object, sourceIntersection, penalty) {
        if (!basePoint || filters.perpendicular === false) return;
        temp.d.subVectors(b, a);
        var lengthSquared = temp.d.lengthSq();
        if (lengthSquared < 1e-18) return;
        var parameter = temp.e.subVectors(basePoint, a).dot(temp.d) / lengthSquared;
        if (parameter < -1e-5 || parameter > 1.00001) return;
        parameter = Math.max(0, Math.min(1, parameter));
        temp.f.copy(a).addScaledVector(temp.d, parameter);
        if (temp.f.distanceToSquared(a) < lengthSquared * 1e-8 || temp.f.distanceToSquared(b) < lengthSquared * 1e-8) return;
        consider(temp.f, object, 'perpendicular', 'PROSTOPADLE ⟂', sourceIntersection, penalty, 1.18);
      }

      var distinctObjects = [];
      var objectHits = new Map();
      hits.slice(0, Math.max(options.maxObjectsPerSnap * 3, 12)).forEach(function (hit) {
        if (!objectHits.has(hit.object)) {
          objectHits.set(hit.object, hit);
          distinctObjects.push(hit.object);
        }
      });
      distinctObjects = distinctObjects.slice(0, options.maxObjectsPerSnap);

      hits.slice(0, 12).forEach(function (hit) {
        var object = hit.object;
        object.updateMatrixWorld(true);
        var geometry = object.geometry;
        var position = geometry.getAttribute && geometry.getAttribute('position');
        var face = hit.face;
        if (!position || !face) return;

        var indices = [face.a, face.b, face.c];
        if (!indices.every(function (value) { return Number.isInteger(value) && value >= 0 && value < position.count; })) return;

        var vertices = [
          worldVertex(object, position, indices[0], new THREE.Vector3()),
          worldVertex(object, position, indices[1], new THREE.Vector3()),
          worldVertex(object, position, indices[2], new THREE.Vector3())
        ];

        vertices.forEach(function (vertex) {
          consider(vertex, object, 'vertex', 'WIERZCHOŁEK / NODE', hit, penalties.meshVertex, 1.05);
        });

        [[0,1], [1,2], [2,0]].forEach(function (pair) {
          var a = vertices[pair[0]];
          var b = vertices[pair[1]];
          ray.distanceSqToSegment(a, b, temp.pointOnRay, temp.pointOnSegment);
          consider(temp.pointOnSegment, object, 'edge', 'KRAWĘDŹ', hit, penalties.meshEdge, 1.0);
          temp.midpoint.copy(a).add(b).multiplyScalar(0.5);
          consider(temp.midpoint, object, 'midpoint', 'ŚRODEK KRAWĘDZI', hit, penalties.meshMidpoint, 1.0);
          considerPerpendicular(a, b, object, hit, penalties.perpendicular + 0.10);
        });
      });

      distinctObjects.forEach(function (object) {
        object.updateMatrixWorld(true);
        var hit = objectHits.get(object);
        var data = buildFeatureData(object.geometry);

        data.circles.forEach(function (circle) {
          temp.a.copy(circle.center).applyMatrix4(object.matrixWorld);
          consider(temp.a, object, 'center', 'ŚRODEK OTWORU / OKRĘGU', hit, penalties.center, 1.25);
        });

        var segments = data.segments;
        var stride = segments.length > options.maxSegmentsPerSnap ? Math.ceil(segments.length / options.maxSegmentsPerSnap) : 1;
        for (var index = 0; index < segments.length; index += stride) {
          var segment = segments[index];
          temp.a.copy(segment.a).applyMatrix4(object.matrixWorld);
          temp.b.copy(segment.b).applyMatrix4(object.matrixWorld);
          ray.distanceSqToSegment(temp.a, temp.b, temp.pointOnRay, temp.pointOnSegment);
          var edgeMetric = rayMetric(ray, temp.pointOnSegment);
          if (!edgeMetric || edgeMetric.angle > maxAngle * 1.12) continue;

          consider(temp.pointOnSegment, object, 'edge', 'KRAWĘDŹ', hit, penalties.edge, 1.12);
          temp.midpoint.copy(temp.a).add(temp.b).multiplyScalar(0.5);
          consider(temp.midpoint, object, 'midpoint', 'ŚRODEK KRAWĘDZI', hit, penalties.midpoint, 1.0);
          consider(temp.a, object, 'vertex', 'WIERZCHOŁEK / NODE', hit, penalties.vertex, 1.0);
          consider(temp.b, object, 'vertex', 'WIERZCHOŁEK / NODE', hit, penalties.vertex, 1.0);
          considerPerpendicular(temp.a, temp.b, object, hit, penalties.perpendicular);
        }
      });

      // Środek otworu musi być możliwy także wtedy, gdy promień przechodzi
      // przez pusty otwór i nie trafia powierzchni części. Dlatego sprawdzamy
      // kołowe pętle również w pobliskich, widocznych meshach przecinanych
      // przez korytarz promienia.
      var searchObjects = [];
      if (Array.isArray(callOptions.searchObjects)) {
        searchObjects = callOptions.searchObjects;
      } else if (callOptions.searchRoot && callOptions.searchRoot.traverse) {
        callOptions.searchRoot.traverse(function (object) {
          if (object && object.isMesh && object.geometry) searchObjects.push(object);
        });
      }

      if (searchObjects.length) {
        var alreadyProcessed = new Set(distinctObjects);
        var nearby = [];
        var searchLimit = Math.min(searchObjects.length, options.maxSearchObjects);
        for (var searchIndex = 0; searchIndex < searchLimit; searchIndex += 1) {
          var searchObject = searchObjects[searchIndex];
          if (!searchObject || alreadyProcessed.has(searchObject) || searchObject.visible === false || !searchObject.geometry) continue;
          var geometry = searchObject.geometry;
          if (!geometry.boundingSphere) geometry.computeBoundingSphere();
          if (!geometry.boundingSphere || !finiteVector(geometry.boundingSphere.center)) continue;

          searchObject.updateMatrixWorld(true);
          temp.c.copy(geometry.boundingSphere.center).applyMatrix4(searchObject.matrixWorld);
          var sphereMetric = rayMetric(ray, temp.c);
          if (!sphereMetric) continue;
          searchObject.getWorldScale(temp.d);
          var maxScale = Math.max(Math.abs(temp.d.x), Math.abs(temp.d.y), Math.abs(temp.d.z), 1e-9);
          var worldRadius = geometry.boundingSphere.radius * maxScale;
          var corridor = worldRadius + sphereMetric.along * Math.tan(maxAngle * 1.4);
          if (sphereMetric.perpendicular > corridor) continue;
          nearby.push({object: searchObject, metric: Math.max(0, sphereMetric.perpendicular - worldRadius)});
        }

        nearby.sort(function (a, b) { return a.metric - b.metric; });
        nearby.slice(0, options.maxCircleCandidateObjects).forEach(function (entry) {
          var object = entry.object;
          var data = buildFeatureData(object.geometry);
          data.circles.forEach(function (circle) {
            temp.a.copy(circle.center).applyMatrix4(object.matrixWorld);
            consider(temp.a, object, 'center', 'ŚRODEK OTWORU / OKRĘGU', null, penalties.center, 1.25);
          });
        });
      }

      if (!best) return null;
      delete best.score;
      if (best.sourceIntersection && best.sourceIntersection.face && best.sourceIntersection.object) {
        try {
          best.normal = best.sourceIntersection.face.normal.clone();
          best.normal.transformDirection(best.sourceIntersection.object.matrixWorld).normalize();
        } catch (error) {
          best.normal = null;
        }
      }
      return best;
    }

    function prepareObject(object) {
      if (!object || !object.traverse) return;
      object.traverse(function (child) {
        if (child && child.isMesh && child.geometry) buildFeatureData(child.geometry);
      });
    }

    return {
      version: VERSION,
      snapFromIntersections: snapFromIntersections,
      prepareObject: prepareObject,
      getFeatureData: buildFeatureData
    };
  }

  global.MOJA_SNAP = {
    version: VERSION,
    createEngine: createEngine
  };
})(typeof window !== 'undefined' ? window : this);
