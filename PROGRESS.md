# Pitch Lab 진행 상황

투수가 실제로 던지지 않고도 투구 수치와 궤적의 관계를 눈으로 익히도록 만드는 3D 투구 궤적 시뮬레이터.

- 게시된 페이지: https://claude.ai/artifact/Rgsh2WCF95isKZtLTGfRZE (비공개, Share 메뉴로 공유)
- 마지막 정리: 2026-11-04

## 파일

| 파일 | 내용 |
|---|---|
| `pitch-lab/index.html` | 화면 구조와 스타일 |
| `pitch-lab/app.js` | UI: 투구 탭, 3D 필드, 수치 보드, 실밥 편집기, 흑백 PiP |
| `pitch-lab/physics.js` | 물리 엔진: 항력, 마그누스, SSW, TrackMan식 무브먼트 계산 |

로컬에서 보기 (`index.html`은 게시용이라 `<!doctype>`이 없고, 인코딩이 깨지지 않도록 첫 줄에 charset을 둠):

```bash
cd pitch-lab && python3 -m http.server 8765
```

## 로드맵

1. **1단계 (진행 중)**: 공의 무브먼트·회전 수치 → 궤적
2. **2단계**: 손목 각도, 전완 내전/외전, 팔꿈치 각도 → 궤적
3. **3단계**: 다리·골반·몸통 → 궤적 (데이터가 더 필요)

단계 사이의 연결 지점은 "릴리스 상태"(구속, 회전수, 회전축, 회전효율, 릴리스 위치, 실밥 방향)로 고정한다.

## 지금 구현된 것

- 인터페이스는 영어, 단위는 mph·inch·ft, 용어는 TrackMan CSV 필드명 기준
- 디자인: 애플 스타일. 시스템 글꼴(SF), 시스템 설정을 따르는 라이트/다크, 그룹형 패널, 세그먼트 컨트롤, iOS식 스위치와 슬라이더, 유리 재질 컨트롤. 3D 필드·실밥 편집기·PiP는 어느 모드에서나 검은 배경. 구종·축 색은 애플 시스템 컬러, PiP 띠는 사용자 요청대로 클로드 주황색 유지
- 처음 열면 존 한가운데로 가는 직구 하나. 투구는 브라우저 탭처럼 추가·선택·삭제, 선택한 투구만 진하게
- 시점: Pitcher(투구판 10 ft 뒤) · Batter(웅크린 눈높이, 신장의 80%, 화각 46°. 릴리스는 우타자 기준 2사분면 중앙, 존 가운데는 4사분면 중앙에 오도록 `app.js`의 `batterPose`가 카메라 위치와 각도를 계산, 좌타자는 좌우 대칭. 존이 잘리지 않아 실제 눈 위치는 아님) · Side · Catcher(존 상단 1/3 높이), 전환 시 카메라가 호를 그리며 1.1초 동안 이동
- Play: 공이 날아가는 만큼 잔상이 자라남. All pitches를 켜면 모든 투구를 함께 재생
- 궤적 클릭으로 선택 변경, Side 뷰 외에서 빈 곳 클릭은 목표 지점 변경
- 궤적 원통 양 끝은 같은 색 돔으로 막음
- Side 뷰의 VAA 옵션: 수평선과 접근선, 쐐기, 각도 라벨
- 탭의 자물쇠로 투구 고정: 고정하면 × 버튼이 사라져 지울 수 없음
- 탭의 눈 아이콘으로 궤적 숨김: 3D, 터널 점, VAA, 상단도, 무브먼트 차트와 All pitches 재생에서 제외(수치와 표는 유지)
- 헤더의 선수 이름과 세트 저장: Save set / Sets 메뉴(불러오기, 두 번 눌러 삭제). 선수 이름당 세트 하나, 같은 이름은 덮어씀. 게시본은 아티팩트 `db`의 `sets` 컬렉션, 로컬은 localStorage
- Pitch tunnel: 각 투구의 릴리스 0.175초 후 위치(`app.js`의 `TUNNEL_T`)에 점. 수치 안내는 수치 보드 맨 아래. 기준은 가장 왼쪽 Fastball 탭, 없으면 가장 왼쪽 탭
- Gathering: 다른 투구의 0.175초 위치가 기준 투구의 궤적 위에 놓이도록 재조준(`physics.js`의 `targetOntoPath`). 끄거나 터널을 끄면 원래 타겟으로 복구, 켜져 있는 동안 해당 투구의 PlateLoc은 잠김
- 배경은 검은 공간: 홈플레이트, 스트라이크존(KBO ABS 27.64%–56.35%), 배터박스, 2D 타자 실루엣, 릴리스 지점의 회전하는 공(1/40 속도), 흐린 원통 궤적
- 수치 보드: Release / Spin / Location / Movement / Inferred / Flight. 입력 칸마다 ↺ 기본값 버튼, 입력 모드 Spin → Movement / Movement → Spin
- 릴리스 위치는 투구별로 수정 가능, 기본값은 신장·팔 각도로 추정
- SSW는 모든 구종에서 기본 꺼짐. Seam 탭의 Apply SSW to the flight로 켬. 꺼져 있어도 힘의 방향은 화살표와 안내로 표시
- Seam 탭: 실밥 방향을 3D 회전 링(X/Y/Z)으로 편집, 실밥 통과 수, 비대칭, 축 편차 표시
- 흑백 PiP: Seam 편집기가 화면 밖이면 오른쪽 아래에 표시. 공이 1/80 속도로 돌고, 회전축에 수직인 스핀 적도에 클로드 주황색 띠와 흰 화살표(고정)

## 물리 모델과 근거

- 항력·양력: Alan Nathan의 근사식(CL = 1.12S/(0.583+2.333S)), RK4 적분 1 ms
- IVB/HB/VB: TrackMan 정의(릴리스 속도 방향의 직선 대비, IVB는 중력 몫을 되돌림)
- 부호: 가로 값은 3루 쪽(투수 오른쪽)이 +, TrackMan HorzRelAngle 기준. PlateLocSide 부호는 TrackMan 문서로 확인 못 함
- Tilt 시계: 투수 시점의 무브먼트 방향, SpinAxis = 180° + 시간당 30°
- SSW: 실밥이 한 바퀴 동안 난류 유도 구역(~80°)과 박리선(~106°)에 머무는 정도를 회전축 양쪽 반구끼리 비교하는 개념 모델. 실밥은 릴리스 순간 회전축 기준으로 고정(그립), 흐름은 비행 중간 방향 기준
- 강도 보정: Nathan(2021) Alex Cobb 싱커(축 편차 17.8°, 비마그누스 약 6.5 in)에 맞춰 SSW_CMAX = 0.14
- Observed 줄: 무브먼트에서 거꾸로 추정한 Tilt(TrackMan Tilt 열), 축 편차(SSW 몫 + 경로 곡률 몫), 무브먼트 기반 Spin Eff./Active Spin

근거 자료:
- Nathan, What Is The Hawkeye Spin Data Teaching Us? I — https://baseball.physics.illinois.edu/HawkeyeSpinAnalysis-Part%20I-rev1.pdf
- TrackMan Radar Glossary — https://support.trackmanbaseball.com/hc/en-us/articles/5089413493787-Radar-Glossary-Of-Terms
- baseballaero, Baseball's Tower of Babel (Post 67) — https://baseballaero.com/2021/01/10/baseballs-tower-of-babel-post-67/

검증(두 차례): SSW 끄면 편차 0, 대칭 포심·투심 SSW 0, 축 기준 roll 불변, 그립 고정 시 SSW 방향이 축과 함께 회전, SSW가 마그누스와 약 93°, Nathan 식 9와 마그누스 방향 차이 1–3°(저효율 슬라이더 6°), 좌우 거울 대칭 오차 0.

## 알려진 한계

- Cobb 싱커는 SSW로 총 무브먼트가 5% 줄지만 모델은 4.6% 늘어남
- 회전효율과 SSW 크기 사이에 단조로운 경향이 약함
- SSW 크기는 사례 하나로 보정한 값

- Gathering 후 낙차가 큰 공은 지면 아래로 지날 수 있음(기본 커브 PlateLocHeight −0.08 ft). 지면 충돌은 계산하지 않음

## 다음에 할 일

- SSW 정교화(사용자가 시간 날 때 하기로 함): 실밥 모델 재검토, 데이터 기반 구종별 비마그누스 무브먼트 적용
- SSW 기본값 검토 결과: 실밥 모델로 전 구종 기본값을 계산하지 않음(TrackMan 데이터에 실밥 방향이 없고, 모델의 SSW 힘이 항상 마그누스와 수직이며 방향 변화에 민감). 실제 데이터로 구종별 비마그누스 무브먼트를 맞추는 쪽이 대안
- 사용자가 줄 TrackMan 수치로 구종별 기본값(`app.js`의 `TYPES`) 교체
- 사용 권한이 있는 참고 이미지를 받으면 타자 실루엣 교체
- 2단계(팔 동작 → 릴리스 상태) 설계
