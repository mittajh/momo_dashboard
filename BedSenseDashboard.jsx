import React, { useState, useMemo, useCallback } from "react";
import Papa from "papaparse";
import {
  addMonths,
  subMonths,
  subDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  getMonth,
  getYear,
  isSameMonth,
  parseISO,
  differenceInMinutes,
  isAfter,
  isBefore,
  isWithinInterval,
  min as dateMin,
  max as dateMax,
  isSameDay,
} from "date-fns";
import { motion } from "framer-motion";
import html2canvas from "html2canvas";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  PointElement,
  LineElement,
  TimeScale,
} from 'chart.js';
import { Bar, Pie, Line } from 'react-chartjs-2';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  TimeScale,
  Title,
  Tooltip,
  Legend,
  ArcElement
);

// ─────────────────────────────────────────────────────────────────────────────
// Tiny, self‑contained UI primitives (no extra UI library needed)
// ─────────────────────────────────────────────────────────────────────────────
const Card = ({ children, style = {}, ...props }) => (
  <div
    style={{
      borderRadius: 12,
      padding: 24,
      marginBottom: 24,
      background: "#ffffff", // Solid white background
      boxShadow: "0 4px 6px rgba(0, 0, 0, 0.07)", // Softer shadow
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);

const Button = ({ children, active = false, ...props }) => (
  <button
    style={{
      padding: "0.6rem 1.1rem",
      borderRadius: 10,
      border: "none",
      cursor: "pointer",
      fontWeight: 600,
      transition: "all .25s ease-out",
      background: active ? "#6366f1" : "#e0e7ff",
      color: active ? "#fff" : "#1e1b4b",
      boxShadow: active ? "0 4px 14px rgba(99,102,241,.25)" : "none",
    }}
    {...props}
  >
    {children}
  </button>
);

const Input = (props) => (
  <input
    style={{
      padding: "0.5rem 0.75rem",
      borderRadius: 10,
      border: "1px solid #cbd5e1",
      background: "#fff",
      fontSize: 14,
    }}
    {...props}
  />
);

// ─────────────────────────────────────────────────────────────────────────────
// Helper palette + utility functions
// ─────────────────────────────────────────────────────────────────────────────
const palettes = {
  default: [ // This won't be used by getPaletteColor directly anymore, but keep for legend?
    "#ef4444", // Red
    "#22c55e", // Green
    "#15803d", // Dark Green
  ],
};

const getPaletteColor = (hours) => {
  // Removed paletteName argument as it's no longer used
  if (hours < 6) {
    return palettes.default[0]; // Red
  } else if (hours < 10) {
    return palettes.default[1]; // Green
  } else {
    return palettes.default[2]; // Dark Green
  }
};

// Helper function to calculate longest continuous sleep
const calculateLongestContinuousSleep = (dailyRawRows) => {
  if (!dailyRawRows || dailyRawRows.length === 0) return 0;

  // Sort by start time just in case
  const sortedRows = dailyRawRows.sort((a, b) => a.start - b.start);

  let longestSleepMinutes = 0;
  let currentSleepStart = null;

  // Define what constitutes an interruption (exit or high restlessness)
  const isInterruption = (row) => {
     return (
         (row.type === 'patient_detection' && String(row.value) === '0') ||
         (row.type === 'restlessness' && String(row.value) === '3')
     );
  };

  // Treat the start of the first non-interrupting event as potential sleep start
  const firstRow = sortedRows[0];
  if (!isInterruption(firstRow)) {
      currentSleepStart = firstRow.start;
  }

  for (let i = 0; i < sortedRows.length; i++) {
    const row = sortedRows[i];
    const nextRow = sortedRows[i + 1];

    if (isInterruption(row)) {
      // Interruption happened, end current sleep segment
      if (currentSleepStart) {
        const duration = differenceInMinutes(row.start, currentSleepStart);
        longestSleepMinutes = Math.max(longestSleepMinutes, duration);
        currentSleepStart = null; // Reset sleep segment
      }
    } else {
      // Not an interruption
      if (!currentSleepStart) {
         // Start of a potential new sleep segment
         currentSleepStart = row.start;
      }
       // Check for gap before next event OR end of data
      const endOfCurrentSegment = nextRow ? nextRow.start : row.end;
      if (nextRow && isAfter(nextRow.start, row.end)) {
          // Gap exists, consider sleep ended at row.end
          const duration = differenceInMinutes(row.end, currentSleepStart);
          longestSleepMinutes = Math.max(longestSleepMinutes, duration);
          // Reset if the next row is an interruption, otherwise it continues implicitly
          if (isInterruption(nextRow)) {
              currentSleepStart = null;
          } // else: gap might be resting, let the next iteration handle it.
      } else if (!nextRow) {
          // Last event, calculate duration until its end
          const duration = differenceInMinutes(row.end, currentSleepStart);
          longestSleepMinutes = Math.max(longestSleepMinutes, duration);
      }
    }
  }

  // Convert minutes to hours
  return longestSleepMinutes / 60;
};

// Define colors for risk score badge
const getRiskScoreColor = (score) => {
  if (score >= 7) return '#ef4444'; // Red
  if (score >= 4) return '#f59e0b'; // Amber
  return '#22c55e'; // Green
};

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function BedSenseDashboard() {
  const [rawRows, setRawRows] = useState([]); // all csv rows
  const [bedNames, setBedNames] = useState([]);
  const [selectedBed, setSelectedBed] = useState(null);
  const [selectedDayKey, setSelectedDayKey] = useState(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [dateRange, setDateRange] = useState({ start: null, end: null });
  const [isLoading, setIsLoading] = useState(false);
  const [highRestlessPercentThreshold, setHighRestlessPercentThreshold] = useState(20); // New threshold in %

  // Use the current color palette logic
  // const currentPalette = palettes.default; // This is less relevant now

  // ───────── CSV parsing ─────────
  // Reverted to handle a single File object
  const handleFile = (file) => {
    setIsLoading(true);
    setRawRows([]);
    setDateRange({ start: null, end: null });
    setBedNames([]);
    setSelectedBed(null);
    setSelectedDayKey(null);
    setIsDetailModalOpen(false);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const parsed = results.data.map((row) => ({
            ...row,
            start: parseISO(row.start_at),
            end: parseISO(row.end_at),
          }));
          // Filter out rows with invalid dates right after parsing
          const validParsed = parsed.filter(r => r.start instanceof Date && !isNaN(r.start) && r.end instanceof Date && !isNaN(r.end));

          if (validParsed.length === 0) {
             alert("No valid data rows found in the CSV. Check 'start_at' and 'end_at' columns and date formats.");
             setIsLoading(false);
             return;
          }

          const uniqueBeds = Array.from(new Set(validParsed.map((r) => r.bed_name))).sort();
          const validDates = validParsed.map(r => r.start);
          const maxDate = dateMax(validDates);
          const minDate = dateMin(validDates);
          const defaultStart = subDays(maxDate, 30);

          setRawRows(validParsed);
          setBedNames(uniqueBeds);
          setSelectedBed(uniqueBeds[0] || null);
          // Set range to last 30 days of data within the file
          setDateRange({ start: dateMax([defaultStart, minDate]), end: maxDate });

          console.log(`Successfully parsed ${validParsed.length} rows from ${file.name}.`);

        } catch (error) {
          console.error("Error processing CSV:", error);
          alert("Error processing CSV file. Please ensure it's in the correct format.");
        } finally {
          setIsLoading(false);
        }
      },
      error: (error) => {
        console.error("PapaParse error:", error);
        alert(`Error parsing CSV file: ${error.message}`);
        setIsLoading(false);
      }
    });
  };

  // ───────── Aggregation ─────────
  const dailyData = useMemo(() => {
    if (!rawRows.length) return {};
    const map = {};
    // Group rows by day first for easier processing
    const rowsByDay = rawRows.reduce((acc, row) => {
        const dayKey = format(row.start, "yyyy-MM-dd");
        if (!acc[dayKey]) acc[dayKey] = [];
        acc[dayKey].push(row);
        return acc;
    }, {});

    Object.keys(rowsByDay).forEach(dayKey => {
        const dayRows = rowsByDay[dayKey];
        // Filter for selected bed if necessary
        const filteredDayRows = selectedBed ? dayRows.filter(r => r.bed_name === selectedBed) : dayRows;
        if (filteredDayRows.length === 0) return; // Skip day if no data for selected bed

        // Sort events within the day for accurate exit/state tracking
        const sortedDayRows = filteredDayRows.sort((a, b) => a.start - b.start);

        map[dayKey] = {
          inBedMinutes: 0,
          repositions: 0,
          exits: 0, // Recalculate exits based on transitions
          restlessCounts: { 1: 0, 2: 0, 3: 0 },
        };

        let isCurrentlyInBed = false; // Track patient state

        sortedDayRows.forEach(row => {
            const valueStr = String(row.value);
            const mins = differenceInMinutes(row.end, row.start);

            // Track in-bed status based on patient_detection
            let wasInBedBeforeEvent = isCurrentlyInBed;
            if (row.type === "patient_detection") {
                const isInBedEvent = (valueStr === "1" || valueStr === "2" || valueStr === "4");
                isCurrentlyInBed = isInBedEvent;

                if (isInBedEvent) {
                  map[dayKey].inBedMinutes += mins;
                } else if (wasInBedBeforeEvent) { // If patient was in bed just before this '0' event
                   map[dayKey].exits += 1; // Count as an exit
                }
            } else {
                // If not a patient detection event, assume state persists unless explicitly changed
                // This handles cases where restlessness or reposition happens while in bed
                if (isCurrentlyInBed) {
                   // Check if this non-detection event implies continued presence
                   // (e.g., restlessness/reposition requires presence)
                   // This might need refinement based on sensor logic assumptions
                }
            }

            // Reposition counting (remains same)
            if (row.type === "reposition" && valueStr === "1") {
              map[dayKey].repositions += 1;
            }
            // Restlessness counting (remains same)
            if (row.type === "restlessness") {
              if (valueStr === '1' || valueStr === '2' || valueStr === '3') {
                map[dayKey].restlessCounts[valueStr] += mins;
              }
            }
        });
    });

    return map;
  }, [rawRows, selectedBed]);

  // Calculate enriched daily data including new KPIs
  const enrichedDailyData = useMemo(() => {
    const enriched = {};
    const dayKeys = Object.keys(dailyData);

    // Filter raw rows for the selected bed ONCE for efficiency
    const filteredRawRows = selectedBed ? rawRows.filter(r => r.bed_name === selectedBed) : rawRows;

    dayKeys.forEach(key => {
      const metrics = dailyData[key];
      const { inBedMinutes, restlessCounts } = metrics; // Exits are now directly from dailyData

      // Calculate Restlessness %
      const restlessMinutes = (restlessCounts['2'] || 0) + (restlessCounts['3'] || 0);
      const restlessPercent = inBedMinutes > 0 ? (restlessMinutes / inBedMinutes) * 100 : 0;

      // Calculate Longest Continuous Sleep
      // Filter already-filtered raw rows further for the specific day
      const dailyRawRows = filteredRawRows.filter(r => format(r.start, "yyyy-MM-dd") === key);
      const longestContinuousSleepHours = calculateLongestContinuousSleep(dailyRawRows);

      // REMOVED Fall Risk Score calculation
      // REMOVED Sleep Score calculation

      enriched[key] = {
        ...metrics, // Includes recalculated exits
        restlessMinutes,
        restlessPercent: restlessPercent.toFixed(1),
        longestContinuousSleepHours: longestContinuousSleepHours.toFixed(1),
        // REMOVED fallRiskScore
        // REMOVED sleepScore
      };
    });
    return enriched;
  }, [dailyData, rawRows, selectedBed]); // Added selectedBed dependency

  // ───────── Derived helpers ─────────
  const daysInView = useMemo(() => {
    if (!dateRange.start || !dateRange.end) return [];
    // Calculate the full grid range including padding weeks
    const gridStart = startOfWeek(dateRange.start, { weekStartsOn: 1 });
    const gridEnd = endOfWeek(dateRange.end, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [dateRange]);

  const summary = useMemo(() => {
    // Use enriched data now
    const days = Object.keys(enrichedDailyData).filter((d) =>
      dateRange.start && dateRange.end && isWithinInterval(parseISO(d), dateRange)
    );
    if (!days.length) return null;

    const metricsForDays = days.map(d => enrichedDailyData[d]);

    const totalHours = metricsForDays.reduce((acc, m) => acc + m.inBedMinutes / 60, 0);
    const totalRepositions = metricsForDays.reduce((acc, m) => acc + m.repositions, 0);
    const totalExits = metricsForDays.reduce((acc, m) => acc + m.exits, 0); // Add total exits
    const totalRestlessPercent = metricsForDays.reduce((acc, m) => acc + parseFloat(m.restlessPercent), 0);
    const longestSleepValues = metricsForDays.map(m => parseFloat(m.longestContinuousSleepHours)).sort((a, b) => a - b);
    
    // Calculate Median for longest sleep
    let medianLongestSleep = 0;
    const mid = Math.floor(longestSleepValues.length / 2);
    if (longestSleepValues.length > 0) {
       medianLongestSleep = longestSleepValues.length % 2 !== 0
           ? longestSleepValues[mid]
           : (longestSleepValues[mid - 1] + longestSleepValues[mid]) / 2;
    }

    return {
      avgHours: (totalHours / days.length).toFixed(1),
      avgRepositions: (totalRepositions / days.length).toFixed(1),
      avgExits: (totalExits / days.length).toFixed(1), // Add avg exits
      avgRestlessPercent: (totalRestlessPercent / days.length).toFixed(1),
      medianLongestSleep: medianLongestSleep.toFixed(1),
      days: days.length,
    };
  }, [enrichedDailyData, dateRange]); // Depend on enriched data

  const textualSummary = useMemo(() => {
    if (!summary || !dateRange.start || !dateRange.end) return null;

    // Use enriched data for analysis within the text
    const relevantDays = Object.entries(enrichedDailyData)
      .map(([key, metrics]) => ({ date: parseISO(key), key, ...metrics }))
      .filter(d => isWithinInterval(d.date, dateRange));

    if (!relevantDays.length) return "No data available for the selected period.";

    let maxHoursDay = null, minHoursDay = null, maxReposDay = null, minSleepDay = null /* removed maxRiskDay */;
    let maxHours = -1, minHours = Infinity, maxRepos = -1, minSleep = Infinity /* removed maxRisk */;
    let exitDaysCount = 0;
    let highRestlessnessDaysCount = 0; // Still based on absolute threshold for now
    let shortSleepDaysCount = 0;

    relevantDays.forEach(day => {
      const hours = day.inBedMinutes / 60;
      const longSleep = parseFloat(day.longestContinuousSleepHours);
      // REMOVED const risk = day.fallRiskScore;

      if (hours > maxHours) { maxHours = hours; maxHoursDay = day.key; }
      if (hours < minHours) { minHours = hours; minHoursDay = day.key; }
      if (day.repositions > maxRepos) { maxRepos = day.repositions; maxReposDay = day.key; }
      if (day.exits > 0) { exitDaysCount++; } // Use new exit count
      // Keep high restlessness check based on original threshold for consistency?
      // Or change this too? Let's keep it for now.
      if ((day.restlessCounts['3'] || 0) > 60) {
        highRestlessnessDaysCount++;
      }
      if (longSleep < minSleep) { minSleep = longSleep; minSleepDay = day.key; }
      if (longSleep < 3) { shortSleepDaysCount++; }
      // REMOVED if (risk > maxRisk) { maxRisk = risk; maxRiskDay = day.key; }
    });

    const formatKeyDate = (key) => format(parseISO(key), 'MMM d');

    const sentences = [
      `Over ${summary.days} days analysed (${format(dateRange.start, 'MMM d')} to ${format(dateRange.end, 'MMM d')}), the average time in bed was ${summary.avgHours} hours/day (${summary.avgRestlessPercent}% restless) with ${summary.avgRepositions} repositions/night and ${summary.avgExits} exits/night. Median longest continuous sleep was ${summary.medianLongestSleep} hours.`, // Added avg exits
      maxHoursDay && `Longest time in bed: ${maxHours.toFixed(1)}h on ${formatKeyDate(maxHoursDay)}.`,
      minHoursDay && minHours !== Infinity && `Shortest time: ${minHours.toFixed(1)}h on ${formatKeyDate(minHoursDay)}.`,
      maxReposDay && `Most repositions: ${maxRepos} on ${formatKeyDate(maxReposDay)}.`,
      exitDaysCount > 0 && `Bed exits occurred on ${exitDaysCount} day(s).`,
      shortSleepDaysCount > 0 && `${shortSleepDaysCount} night(s) had less than 3 hours of continuous sleep.`,
      minSleepDay && minSleep !== Infinity && `Shortest continuous sleep: ${minSleep.toFixed(1)}h on ${formatKeyDate(minSleepDay)}.`,
      // REMOVED Highest fall risk sentence
      // highRestlessnessDaysCount > 0 && `Significant high restlessness (> ${highRestlessnessThreshold} min) observed on ${highRestlessnessDaysCount} day(s).` // Maybe remove this if covered by %?
    ];

    return sentences.filter(Boolean).join(' ');

  }, [enrichedDailyData, dateRange, summary]); // Depend on enriched data

  // Calculate data for Trend Charts
  const trendData = useMemo(() => {
    if (!dateRange.start || !dateRange.end) return null;

    const daysInRange = eachDayOfInterval({ start: dateRange.start, end: dateRange.end });
    const labels = [];
    const hours = [];
    const repositions = [];
    const exits = [];
    const restlessPercents = []; // Add restless % data

    daysInRange.forEach(day => {
      const dayKey = format(day, 'yyyy-MM-dd');
      const metrics = enrichedDailyData[dayKey]; // Use enriched data
      labels.push(format(day, 'MMM d')); // Format for chart label
      hours.push(metrics ? (metrics.inBedMinutes / 60) : 0);
      repositions.push(metrics ? metrics.repositions : 0);
      exits.push(metrics ? metrics.exits : 0);
      restlessPercents.push(metrics ? parseFloat(metrics.restlessPercent) : 0);
    });

    // Only return data if there's more than one day to show a trend
    if (labels.length <= 1) return null;

    return { labels, hours, repositions, exits, restlessPercents }; // Add restlessPercents

  }, [enrichedDailyData, dateRange]); // Depend on enriched data

  // ───────── Screenshot ─────────
  const savePNG = () => {
    const node = document.getElementById("calendar-wrapper");
    html2canvas(node).then((canvas) => {
      const link = document.createElement("a");
      link.download = "bedsense_calendar.png";
      link.href = canvas.toDataURL();
      link.click();
    });
  };

  // ───────── Preset Date Handlers ─────────
  const setPresetRange = (days) => {
    if (!rawRows.length) return;
    const maxDate = dateMax(rawRows.map((r) => r.start));
    const start = subDays(maxDate, days - 1);
    setDateRange({ start, end: maxDate });
    handleCloseModal();
  };

  const setThisMonthRange = () => {
    if (!rawRows.length) return;
    const now = new Date();
    const start = startOfMonth(now);
    const end = endOfMonth(now);
    const maxDataDate = dateMax(rawRows.map(r => r.start));
    setDateRange({ start: dateMax([start, dateMin(rawRows.map(r => r.start))]), end: dateMin([end, maxDataDate]) });
    handleCloseModal();
  };

  const setLastMonthRange = () => {
    if (!rawRows.length) return;
    const lastMonth = subMonths(new Date(), 1);
    const start = startOfMonth(lastMonth);
    const end = endOfMonth(lastMonth);
    const maxDataDate = dateMax(rawRows.map(r => r.start));
    const minDataDate = dateMin(rawRows.map(r => r.start));
    setDateRange({ start: dateMax([start, minDataDate]), end: dateMin([end, maxDataDate]) });
    handleCloseModal();
  };

  // ───────── Modal Handlers ─────────
  const handleDayClick = useCallback((dayKey) => {
    if (dailyData[dayKey]) {
      setSelectedDayKey(dayKey);
      setIsDetailModalOpen(true);
    }
  }, [dailyData]);

  const handleCloseModal = useCallback(() => {
    setIsDetailModalOpen(false);
    setSelectedDayKey(null);
  }, []);

  // ───────── Render ─────────
  // --- Render Logic Change ---
  // 1. Initial Setup Screen (if no data)
  if (rawRows.length === 0 && !isLoading) {
    return <InitialSetupScreen onFileLoad={handleFile} isLoading={isLoading} />;
  }

  // 2. Loading Screen
  if (isLoading) {
     return (
        <div style={loadingOverlayStyle}>
           Loading and processing data...
        </div>
     );
  }

  // 3. Main Dashboard (if data loaded)
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #a6f2e6 0%, #d0d9ff 100%)",
        fontFamily: "Inter, sans-serif",
        fontSize: '15px',
        // REMOVED display: flex (no longer needed for sidebar)
        padding: 32, // Add padding directly to the main container
      }}
      // REMOVED onDragOver and onDrop
    >
      {/* REMOVED Sidebar Component */}
      {/* REMOVED Sidebar Toggle Button */}

      {/* Main Content Area - Now the primary container */}
      <div
        style={{
          maxWidth: '1600px', // Wider max width maybe?
          margin: '0 auto', // Center content
          // REMOVED flexGrow, marginLeft, transition, overflowY, height
        }}
      >
        <motion.h1
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          style={{ color: "#1e1b4b", fontSize: 32, fontWeight: 800, marginBottom: 24, textAlign: 'center' }} // Center title
        >
          BedSense Trend Dashboard
        </motion.h1>

        {/* REMOVED Latest Night Summary Card */}
        {/* REMOVED Loading Indicator (handled above) */}
        {/* REMOVED Empty State Prompt (handled by InitialSetupScreen) */}

        {/* Main Dashboard Content Grid */}
        {rawRows.length > 0 && ( // Should always be true here, but keep check
          <div style={{
              // Using flexbox for easier control than grid for main sections
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
          }}>

            {/* Controls Card (Moved from Sidebar) */}
            <ControlsCard
                bedNames={bedNames}
                selectedBed={selectedBed}
                setSelectedBed={setSelectedBed}
                dateRange={dateRange}
                setDateRange={setDateRange}
                setPresetRange={setPresetRange}
                setThisMonthRange={setThisMonthRange}
                setLastMonthRange={setLastMonthRange}
                highRestlessPercentThreshold={highRestlessPercentThreshold}
                setHighRestlessPercentThreshold={setHighRestlessPercentThreshold}
                savePNG={savePNG}
                onNewFile={() => { /* Logic to trigger new file upload - maybe reset state? */
                   setRawRows([]); // Go back to initial setup screen
                   // Reset other states as needed
                   setDateRange({ start: null, end: null });
                   setBedNames([]);
                   setSelectedBed(null);
                   setSelectedDayKey(null);
                }}
            />

            {/* KPI Strip (Sticky) */}
            {summary && (
               <div style={{
                 position: 'sticky',
                 top: 0, // Stick to top of viewport
                 zIndex: 10,
                 backgroundColor: 'rgba(218, 228, 255, 0.8)', // Light blue semi-transparent background when sticky
                 backdropFilter: 'blur(8px)',
                 padding: '10px 0', // Add padding when sticky
                 borderRadius: '12px', // Match card rounding
                 boxShadow: '0 4px 10px rgba(0, 0, 0, 0.1)', // Add shadow when sticky
                 marginTop: '-10px', // Offset padding slightly if needed
                 marginBottom: '16px' // Space below sticky KPI
               }}>
                  <Card style={{
                      display: "flex",
                      gap: 32,
                      justifyContent: "space-around",
                      flexWrap: 'wrap',
                      marginBottom: 0, // Remove bottom margin as it's handled by wrapper
                      background: 'transparent', // Make card background transparent
                      boxShadow: 'none', // Remove card shadow as wrapper has it
                  }}>
                    <Stat label="Avg hours in bed / day" value={summary.avgHours} />
                    <Stat label="Avg repositions / night" value={summary.avgRepositions} />
                    <Stat label="Avg exits / night" value={summary.avgExits} /> {/* Add avg exits stat */}
                    <Stat label="Avg Restless %" value={summary.avgRestlessPercent ? `${summary.avgRestlessPercent}%` : 'N/A'} />
                    <Stat label="Median Longest Sleep (h)" value={summary.medianLongestSleep || 'N/A'} />
                    <Stat label="Days analysed" value={summary.days} />
                  </Card>
               </div>
            )}

             {/* Textual Summary */}
             {textualSummary && (
               <Card>
                 <h4 style={{ marginTop: 0, marginBottom: 12, color: '#1e1b4b', fontWeight: 600 }}>Summary</h4>
                 <p style={{ margin: 0, color: '#334155', lineHeight: 1.6 }}>
                   {textualSummary}
                 </p>
               </Card>
             )}

             {/* Trend Analysis Charts */}
             {trendData && (
               <Card>
                 <h4 style={{ marginTop: 0, marginBottom: 20, color: '#1e1b4b', fontWeight: 600 }}>Trend Analysis</h4>
                 <TrendCharts data={trendData} /> {/* Will update this component next */}
               </Card>
             )}

             {/* Calendar */}
             <div id="calendar-wrapper"> {/* Removed margin top, handled by gap */}
               {daysInView.length > 0 && (
                 <CalendarGrid
                   days={daysInView}
                   data={enrichedDailyData}
                   onDayClick={handleDayClick}
                   selectedDayKey={selectedDayKey}
                   highRestlessPercentThreshold={highRestlessPercentThreshold}
                   selectedDateRange={dateRange}
                   // REMOVED palette={currentPalette} (no longer needed)
                   // REMOVED getRiskScoreColor (no longer needed)
                 />
               )}
             </div>

              {/* Controls Card MOVED UP */}
              {/* Summary Stats MOVED UP - Made Sticky */}


            {/* Detail Modal */}
            <DayDetailModal
              isOpen={isDetailModalOpen}
              onClose={handleCloseModal}
              dayData={selectedDayKey ? enrichedDailyData[selectedDayKey] : null}
              avgData={summary} // Pass updated summary with avgExits
              dayKey={selectedDayKey}
              // Corrected typo: selectedKey -> selectedDayKey
              // Also filter by selectedBed if applicable
              rawRowsForDay={selectedDayKey ? rawRows.filter(r => 
                  (selectedBed ? r.bed_name === selectedBed : true) && 
                  format(r.start, "yyyy-MM-dd") === selectedDayKey
              ) : []} 
              // REMOVED highRestlessPercentThreshold prop
            />
          </div> // End Main Dashboard Content Grid
        )}
      </div> {/* End Main Content Area */}
    </div> // End Page Container
  );
}

// ────────────────── Initial Setup Screen (New) ──────────────────
const InitialSetupScreen = ({ onFileLoad, isLoading }) => {
  const onDragOver = (e) => e.preventDefault();
  const onDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      onFileLoad(e.dataTransfer.files[0]);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: "linear-gradient(135deg, #a6f2e6 0%, #d0d9ff 100%)",
        padding: 32,
        fontFamily: "Inter, sans-serif",
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Card style={{ maxWidth: 500, width: '100%', textAlign: 'center' }}>
        <h2 style={{ color: '#1e1b4b', marginBottom: 15 }}>Load BedSense Data</h2>
        <p style={{ color: '#475569', marginBottom: 25 }}>
          Drag & drop your CSV file here, or click below to select a file.
        </p>
        <Input
          type="file"
          accept=".csv"
          onChange={(e) => e.target.files && e.target.files.length > 0 && onFileLoad(e.target.files[0])}
          disabled={isLoading}
          style={{
             display: 'block',
             width: '80%',
             margin: '0 auto',
             padding: '10px',
             border: '2px dashed #cbd5e1',
             background: '#f8fafc',
             cursor: 'pointer',
          }}
        />
        {isLoading && <p style={{ marginTop: 20, color: '#475569' }}>Processing file...</p>}
      </Card>
    </div>
  );
};

// ────────────────── Controls Card (New - Replaces Sidebar) ──────────────────
const ControlsCard = ({
  bedNames, selectedBed, setSelectedBed, dateRange, setDateRange,
  setPresetRange, setThisMonthRange, setLastMonthRange,
  highRestlessPercentThreshold, setHighRestlessPercentThreshold, savePNG, onNewFile
}) => {
  const [isExpanded, setIsExpanded] = useState(true); // Controls visibility

  return (
    <Card style={{ transition: 'max-height 0.3s ease-out', overflow: 'hidden' }}>
       <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isExpanded ? 16 : 0, cursor: 'pointer'}} onClick={() => setIsExpanded(!isExpanded)}>
           <h4 style={{ margin: 0, color: '#1e1b4b', fontWeight: 600 }}>Controls & Settings</h4>
           <span>{isExpanded ? '▲ Collapse' : '▼ Expand'}</span>
       </div>

       {isExpanded && (
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px'}}>
              {/* File Upload (Button to trigger reset) */}
              <div>
                <label style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#334155', display: 'block' }}>Data File</label>
                <Button onClick={onNewFile} style={{ width: '100%' }}>Load New CSV File</Button>
              </div>

              {/* Bed Selector */}
              {bedNames.length > 1 && (
                <div>
                  <label style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#334155', display: 'block' }}>Bed</label>
                  <select
                    value={selectedBed || ''}
                    onChange={(e) => setSelectedBed(e.target.value)}
                    style={{ padding: "0.5rem", borderRadius: 8, border: "1px solid #cbd5e1", width: '100%', height: '38px' /* Align height */}}
                  >
                    {bedNames.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Date Range Pickers */}
              <div>
                <label style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#334155', display: 'block' }}>Date Range</label>
                <div style={{display: 'flex', gap: '10px'}}>
                    <Input
                      type="date"
                      value={dateRange.start ? format(dateRange.start, "yyyy-MM-dd") : ""}
                      onChange={(e) => {
                          const newStart = parseISO(e.target.value);
                          // Ensure the date is valid and start is before or same as end
                          if (newStart instanceof Date && !isNaN(newStart) && 
                              (!dateRange.end || isBefore(newStart, dateRange.end) || isSameDay(newStart, dateRange.end))) {
                            setDateRange((prev) => ({ ...prev, start: newStart }));
                          }
                      }}
                      max={dateRange.end ? format(dateRange.end, "yyyy-MM-dd") : undefined}
                      title="From Date"
                      style={{flex: 1}}
                    />
                    <Input
                      type="date"
                      value={dateRange.end ? format(dateRange.end, "yyyy-MM-dd") : ""}
                      onChange={(e) => {
                          const newEnd = parseISO(e.target.value);
                          // Ensure the date is valid and end is after or same as start
                          if (newEnd instanceof Date && !isNaN(newEnd) && 
                              (!dateRange.start || isAfter(newEnd, dateRange.start) || isSameDay(newEnd, dateRange.start))) {
                            setDateRange((prev) => ({ ...prev, end: newEnd }));
                          }
                      }}
                      min={dateRange.start ? format(dateRange.start, "yyyy-MM-dd") : undefined}
                      title="To Date"
                      style={{flex: 1}}
                    />
                </div>
                 {/* Preset Date Ranges Buttons */}
                 <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
                    <Button onClick={() => setPresetRange(7)}>7d</Button>
                    <Button onClick={() => setPresetRange(30)}>30d</Button>
                    <Button onClick={() => setThisMonthRange()}>Month</Button>
                    <Button onClick={() => setLastMonthRange()}>Last Month</Button>
                 </div>
              </div>

              {/* Threshold Input */}
              <div>
                <label style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#334155', display: 'block' }}>High Restless (%)</label>
                <Input
                  type="number"
                  value={highRestlessPercentThreshold}
                  onChange={(e) => setHighRestlessPercentThreshold(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
                  style={{ width: '80px', padding: '0.3rem 0.5rem' }}
                  min="0"
                  max="100"
                  step="5"
                />
              </div>

              {/* Actions */}
               <div>
                  <label style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: '#334155', display: 'block' }}>Actions</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                     <Button onClick={savePNG}>Save PNG</Button>
                  </div>
               </div>
          </div>
       )}
    </Card>
  );
};

// ────────────────── Sub‑components ──────────
// Update Stat Typography
const Stat = ({ label, value }) => (
  <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 28, fontWeight: 700, color: "#1e1b4b" }}>{value}</div>
    {/* Use medium weight for label */}
    <div style={{ fontSize: 14, color: "#475569", fontWeight: 500 }}>{label}</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Helper Components (Small & Specific)
// ─────────────────────────────────────────────────────────────────────────────

// Inline Legend Component (New)
const InlineLegend = ({ palette }) => {
  const numSwatches = 5; // Show 5 distinct steps
  const indices = Array.from({ length: numSwatches }, (_, i) =>
    Math.floor(i * (palette.length - 1) / (numSwatches - 1))
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ fontSize: 11, color: '#475569', marginRight: '4px' }}>0h</span>
      {indices.map((index, i) => (
        <div
          key={i}
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            backgroundColor: palette[index],
          }}
          title={`${Math.round(index / (palette.length - 1) * 16)}h`} // Approximate hour value
        />
      ))}
      <span style={{ fontSize: 11, color: '#475569', marginLeft: '4px' }}>16h+</span>
    </div>
  );
};

const ActivityIndicator = ({ type, style }) => {
  const indicatorStyles = {
    base: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      position: 'absolute',
      bottom: 4,
    },
    exit: {
      backgroundColor: 'rgba(255, 255, 255, 0.8)', // White dot for exit
      right: 12,
    },
    highRestlessness: {
      backgroundColor: 'rgba(239, 68, 68, 0.9)', // Red dot for high restlessness
      right: 4,
    },
  };

  return (
    <span style={{ ...indicatorStyles.base, ...indicatorStyles[type], ...style }}
      title={type === 'exit' ? 'Bed Exit Recorded' : 'Significant High Restlessness'}
    />
  );
};

// Simple SVG Sparkline Component
const Sparkline = ({ data, width = 60, height = 15, stroke = "#6366f1", strokeWidth = 1.5 }) => {
  if (!data || data.length < 2) return null;

  // Normalize data (0 = min value, 1 = max value)
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min; // Avoid division by zero
  const normalized = data.map(val => (val - min) / range);

  // Create SVG path string
  const points = normalized.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (val * height); // Invert Y for SVG coords
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  return (
    <svg 
       width={width} 
       height={height} 
       viewBox={`0 0 ${width} ${height}`} 
       style={{ overflow: 'visible' }} // Allow stroke to extend slightly
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
};

const CalendarGrid = ({ days, data, onDayClick, selectedDayKey, highRestlessPercentThreshold, selectedDateRange }) => {
  let lastMonth = null; // Track month changes
  const [hoveredDayKey, setHoveredDayKey] = useState(null); // State for hover

  // Memoize sparkline data calculation
  const sparklineData = useMemo(() => {
      if (!hoveredDayKey || !data) return null;

      const hoveredDate = parseISO(hoveredDayKey);
      const history = [];
      for (let i = 6; i >= 0; i--) {
          const date = subDays(hoveredDate, i);
          const key = format(date, 'yyyy-MM-dd');
          const metrics = data[key];
          // Use hours in bed for sparkline, default to 0 if no data
          history.push(metrics ? (metrics.inBedMinutes / 60) : 0);
      }
      // Ensure we have at least two points for a line
      return history.length >= 2 ? history : null;
  }, [hoveredDayKey, data]);

  return (
    <>
      {/* Weekday Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 6,
          marginBottom: 8, // Add space below header
        }}
      >
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
          <div key={day} style={{ textAlign: 'center', fontWeight: 600, fontSize: 12, color: '#475569', paddingBottom: 4 }}>
            {day}
          </div>
        ))}
      </div>
      {/* Main Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 6,
        }}
      >
        {days.map((day, idx) => {
          const key = format(day, "yyyy-MM-dd");
          const metrics = data[key];
          const inBedHours = metrics ? metrics.inBedMinutes / 60 : 0;
          const hasData = !!metrics;
          const isInSelectedRange = isWithinInterval(day, selectedDateRange);

          // --- Month Header Logic ---
          const currentMonth = format(day, 'MMMM yyyy');
          let monthHeader = null;
          if (format(day, 'yyyy-MM') !== lastMonth) {
              // Display header only if it's the first day of the month OR the first day in the grid overall
              if (format(day, 'd') === '1' || idx === 0) {
                  monthHeader = (
                      <h2 style={{
                          color: '#1e1b4b',
                          fontWeight: 700,
                          fontSize: '1.3em',
                          gridColumn: '1 / -1', // Span full width
                          marginTop: idx === 0 ? 0 : '20px', // Add margin top unless it's the very first row
                          marginBottom: '10px',
                          textAlign: 'left', // Align left
                      }}>
                          {currentMonth}
                      </h2>
                  );
              }
              lastMonth = format(day, 'yyyy-MM');
          }
          // --- End Month Header Logic ---

          // Updated anomaly checks
          const hasExit = metrics?.exits > 0;
          const hasShortSleep = metrics && parseFloat(metrics.longestContinuousSleepHours) < 3;
          const isHighRestlessnessDay = metrics && parseFloat(metrics.restlessPercent) > highRestlessPercentThreshold; // Use threshold %

          const backgroundColor = isInSelectedRange ? getPaletteColor(inBedHours) : '#f1f5f9';
          const opacity = isInSelectedRange ? 1 : 0.5;
          const cursor = isInSelectedRange && hasData ? 'pointer' : 'default';
          const tileBorder = isInSelectedRange && metrics && (isHighRestlessnessDay || metrics.exits > 2 /* Example threshold for exits */)
            ? '2px solid #ef4444' // Anomaly border (Red-500 equivalent)
            : '1px solid #e2e8f0'; // Default border

          return (
            <React.Fragment key={key}>
              {/* Render month header if needed */}
              {monthHeader}
              {/* Render the day tile */}
              <motion.div
                onMouseEnter={() => isInSelectedRange && hasData && setHoveredDayKey(key)} // Set hovered day
                onMouseLeave={() => setHoveredDayKey(null)} // Clear hover
                style={{
                  height: 70,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "column",
                  color: isInSelectedRange && inBedHours > 8 ? "#fff" : "#1e1b4b",
                  background: backgroundColor,
                  opacity: opacity,
                  position: "relative",
                  border: tileBorder, // Use updated border logic
                  cursor: cursor,
                  transition: 'transform 0.2s ease-out, box-shadow 0.2s ease-out, border-color 0.2s ease-out',
                  boxShadow: selectedDayKey === key ? '0 0 0 3px #6366f1' : 'none',
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: idx * 0.01 }}
                whileHover={isInSelectedRange && hasData ? { scale: 1.05, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" } : {}}
                onClick={() => isInSelectedRange && hasData && onDayClick(key)}
                title={isInSelectedRange && metrics ?
                  `${format(day, "MMM d")}\nTime in bed: ${inBedHours.toFixed(1)}h\nRestless: ${metrics.restlessPercent}%\nLongest Sleep: ${metrics.longestContinuousSleepHours}h\nExits: ${metrics.exits}\nRepositions: ${metrics.repositions}` // Updated title
                  : isInSelectedRange ? format(day, "MMM d") : ""}
              >
                <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.9 }}>{format(day, "d")}</span>
                <div style={{ marginTop: 2, lineHeight: 1 }}>
                  {isInSelectedRange && inBedHours > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                      {inBedHours.toFixed(0)}h
                    </span>
                  )}
                </div>
                {/* Add Restless % below hours */}
                 {isInSelectedRange && metrics && (
                    <div style={{
                         fontSize: 9,
                         opacity: 0.7,
                         marginTop: 1,
                         color: isInSelectedRange && inBedHours > 8 ? '#fff' : '#1e1b4b' // Match text color
                     }}>
                       {metrics.restlessPercent}% R
                    </div>
                 )}

                {/* Indicators container */}
                <div style={{
                    position: 'absolute',
                    bottom: 4,
                    left: 4,
                    right: 4,
                    display: 'flex',
                    justifyContent: 'space-between', // Space out indicators
                    alignItems: 'center',
                    pointerEvents: 'none'
                }}>
                    {/* Left side indicators (Exit, Short Sleep) */}
                    <div style={{display: 'flex', gap: '3px'}}>
                       {isInSelectedRange && hasData && hasExit && <span style={{width:5, height:5, borderRadius:'50%', background:'rgba(0,0,0,0.4)'}} title="Bed Exit"></span>}
                       {isInSelectedRange && hasData && hasShortSleep && <span style={{width:0,height:0, borderLeft:'4px solid transparent', borderRight:'4px solid transparent', borderBottom:'6px solid rgba(0,0,0,0.6)'}} title="< 3h Continuous Sleep"></span>}
                    </div>
                    {/* Right side: High Restlessness Indicator */}
                    {isInSelectedRange && hasData && isHighRestlessnessDay && (
                       <span style={{
                           width: 6, height: 6, borderRadius: '50%',
                           background: 'rgba(239, 68, 68, 0.9)', // Red dot
                       }} title={`> ${highRestlessPercentThreshold}% Restless`}>
                       </span>
                   )}
                   {/* REMOVED Fall Risk Badge */}
                </div>

                 {/* Sparkline on Hover */}
                 {hoveredDayKey === key && sparklineData && (
                     <div style={{
                         position: 'absolute',
                         bottom: 'calc(100% + 5px)', // Position above the tile
                         left: '50%',
                         transform: 'translateX(-50%)',
                         background: 'rgba(255, 255, 255, 0.9)',
                         padding: '4px 6px',
                         borderRadius: '4px',
                         boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                         zIndex: 20, // Ensure it's above other elements
                         pointerEvents: 'none' // Don't let tooltip block hover on tile below
                     }}>
                         <Sparkline data={sparklineData} />
                     </div>
                 )}

              </motion.div>
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

// ────────────────── Trend Chart Component (New) ──────────────────
const TrendCharts = ({ data }) => {
  if (!data || !data.labels || data.labels.length === 0) return <p style={{textAlign: 'center', color: '#64748b'}}>Not enough data for trend analysis.</p>;

  // Calculate Mean and Standard Deviation for Hours
  const hoursData = data.hours.filter(h => typeof h === 'number' && !isNaN(h));
  const nHours = hoursData.length;
  const meanHours = nHours > 0 ? hoursData.reduce((a, b) => a + b, 0) / nHours : 0;
  const stdDevHours = nHours > 0 ? Math.sqrt(hoursData.map(x => Math.pow(x - meanHours, 2)).reduce((a, b) => a + b, 0) / nHours) : 0;
  const meanHoursLine = Array(data.labels.length).fill(meanHours);
  const stdDevPlusHoursLine = Array(data.labels.length).fill(meanHours + stdDevHours);
  const stdDevMinusHoursLine = Array(data.labels.length).fill(Math.max(0, meanHours - stdDevHours));

  // Calculate Mean and Standard Deviation for Repositions
  const reposData = data.repositions.filter(r => typeof r === 'number' && !isNaN(r));
  const nRepos = reposData.length;
  const meanRepos = nRepos > 0 ? reposData.reduce((a, b) => a + b, 0) / nRepos : 0;
  const stdDevRepos = nRepos > 0 ? Math.sqrt(reposData.map(x => Math.pow(x - meanRepos, 2)).reduce((a, b) => a + b, 0) / nRepos) : 0;
  const meanReposLine = Array(data.labels.length).fill(meanRepos);
  const stdDevPlusReposLine = Array(data.labels.length).fill(meanRepos + stdDevRepos);
  const stdDevMinusReposLine = Array(data.labels.length).fill(Math.max(0, meanRepos - stdDevRepos));


  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false, // Allow charts to resize height
    plugins: {
      legend: {
        position: 'top',
      },
      tooltip: {
        mode: 'index',
        intersect: false,
      },
    },
    scales: {
      x: {
        // Since labels are strings ('MMM d'), use 'category' scale type
        type: 'category',
        title: {
          display: false, // Keep axis clean, main title is enough
          text: 'Date',
        },
         ticks: {
           maxRotation: 0, // Prevent label rotation if possible
           autoSkip: true, // Allow chart.js to skip labels if too dense
           maxTicksLimit: 10 // Limit the number of visible ticks
         }
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Value', // Generic label, overridden below
        },
        id: 'y', 
        position: 'left',
      },
    },
  };

  const hoursChartData = {
    labels: data.labels,
    datasets: [
      {
        label: 'Hours in Bed',
        data: data.hours,
        borderColor: '#6366f1', // Indigo
        backgroundColor: 'rgba(99, 102, 241, 0.5)',
        tension: 0.1, // Slight curve
        fill: false,
        yAxisID: 'y', // Assign to the primary y-axis
      },
      // Add Mean and StdDev Lines
      {
        label: 'Mean Hours',
        data: meanHoursLine,
        borderColor: '#334155', // Dark Gray/Slate
        borderWidth: 2, // Thicker mean line
        pointRadius: 0, // No points on the mean line
        fill: false,
        yAxisID: 'y',
      },
      {
        label: 'Mean +1 Std Dev',
        data: stdDevPlusHoursLine,
        borderColor: 'rgba(148, 163, 184, 0.7)', // Lighter Gray/Slate with opacity
        borderDash: [5, 5], // Dashed line
        borderWidth: 1.5, // Slightly thinner dashed line
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
      },
      {
        label: 'Mean -1 Std Dev',
        data: stdDevMinusHoursLine,
        borderColor: 'rgba(148, 163, 184, 0.7)', // Lighter Gray/Slate with opacity
        borderDash: [5, 5], // Dashed line
        borderWidth: 1.5, // Slightly thinner dashed line
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
      },
    ],
  };

  const reposChartData = {
      labels: data.labels,
      datasets: [
        {
          label: 'Reposition Events',
          data: data.repositions,
          borderColor: '#f59e0b', // Amber
          backgroundColor: 'rgba(245, 158, 11, 0.5)',
          tension: 0.1,
          fill: false,
          yAxisID: 'y',
        },
        // Add Mean and StdDev Lines for Repositions
        {
          label: 'Mean Repositions',
          data: meanReposLine,
          borderColor: '#334155', // Dark Gray/Slate
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          yAxisID: 'y',
        },
        {
          label: 'Mean +1 Std Dev',
          data: stdDevPlusReposLine,
          borderColor: 'rgba(148, 163, 184, 0.7)',
          borderDash: [5, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          yAxisID: 'y',
        },
        {
          label: 'Mean -1 Std Dev',
          data: stdDevMinusReposLine,
          borderColor: 'rgba(148, 163, 184, 0.7)',
          borderDash: [5, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          yAxisID: 'y',
        },
      ],
  };

  const eventsChartData = {
    labels: data.labels,
    datasets: [
      {
        label: 'Bed Exits',
        data: data.exits,
        backgroundColor: '#f59e0b', // Amber
        // Ensure this uses the primary y-axis implicitly, or assign yAxisID: 'y' if needed
      },
    ],
  };

  return (
    // Use 1fr 1fr for side-by-side layout on wider screens if desired,
    // but stacking (1fr) is safer for responsiveness.
    // Let's keep the single column grid but constrain the chart heights.
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '40px' }}>
      {/* Increased gap */}
      <div>
        <h5 style={{ textAlign: 'center', marginBottom: '15px', color: '#334155' }}>Hours in Bed Over Time</h5>
        {/* Wrap chart in a div with controlled height */}
        <div style={{ position: 'relative', height: '250px' }}>
          <Line options={{...commonOptions, scales: {...commonOptions.scales, y: {...commonOptions.scales.y, title: {display: true, text: 'Hours'}}}}} data={hoursChartData} />
        </div>
      </div>
      <div>
        <h5 style={{ textAlign: 'center', marginBottom: '15px', color: '#334155' }}>Reposition Events Over Time</h5>
        <div style={{ position: 'relative', height: '250px' }}>
          <Line options={{...commonOptions, scales: {...commonOptions.scales, y: {...commonOptions.scales.y, title: {display: true, text: 'Events'}}}}} data={reposChartData} />
        </div>
      </div>
      <div>
        <h5 style={{ textAlign: 'center', marginBottom: '15px', color: '#334155' }}>Daily Bed Exits</h5>
        <div style={{ position: 'relative', height: '250px' }}>
          <Bar options={{...commonOptions, scales: {...commonOptions.scales, y: {...commonOptions.scales.y, title: {display: true, text: 'Count'}}}}} data={eventsChartData} />
        </div>
      </div>
    </div>
  );
};

// ────────── Activity Timeline Component (for Modal) ──────────

const ActivityTimeline = ({ rows, dayKey }) => {
  if (!rows || !dayKey) return null;

  // --- Configuration ---
  const timelineHoursStart = 18; // Start at 6 PM previous day
  const totalTimelineHours = 24;
  const totalTimelineMinutes = totalTimelineHours * 60; // 1440 minutes

  // --- Calculate Timeline Boundaries ---
  const selectedDate = parseISO(dayKey);
  const timelineStart = new Date(selectedDate);
  timelineStart.setHours(timelineHoursStart, 0, 0, 0); // Set to 6 PM
  // If selectedDate is the start of the day, go back one day for the 6 PM start
  if (selectedDate.getHours() < timelineHoursStart) {
     timelineStart.setDate(timelineStart.getDate() - 1);
  }

  const timelineEnd = new Date(timelineStart);
  timelineEnd.setHours(timelineEnd.getHours() + totalTimelineHours); // End 24 hours later

  // --- Filter and Sort Rows within the 24h window ---
  const relevantRows = rows
    .filter(row => isWithinInterval(row.start, { start: timelineStart, end: timelineEnd }) || isWithinInterval(row.end, { start: timelineStart, end: timelineEnd }))
    .sort((a, b) => a.start - b.start);

  if (relevantRows.length === 0) {
     return <p style={{textAlign: 'center', color: '#64748b', margin: '20px 0'}}>No activity recorded between {format(timelineStart, 'HH:mm')} and {format(timelineEnd, 'HH:mm')}.</p>;
  }

  const segments = [];
  let currentPositionTime = timelineStart; // Start tracking from the beginning of the 24h window

  relevantRows.forEach(row => {
    const segmentStart = dateMax([row.start, timelineStart]); // Clamp start to timeline boundary
    const segmentEnd = dateMin([row.end, timelineEnd]);     // Clamp end to timeline boundary

    // 1. Add Gap before this segment (if any)
    if (isAfter(segmentStart, currentPositionTime)) {
      const gapDuration = differenceInMinutes(segmentStart, currentPositionTime);
      if (gapDuration > 0.1) { // Avoid tiny gaps
        segments.push({ type: 'gap', duration: gapDuration, start: currentPositionTime, end: segmentStart });
      }
    }

    // 2. Determine Segment Type
    let type = 'resting'; // Default
     if (row.type === 'restlessness') {
      if (row.value === '3' || row.value === 3) type = 'high';
      else if (row.value === '2' || row.value === 2) type = 'light';
      // Level 1 ('1') is resting
    } else if (row.type === 'patient_detection' && (row.value === '0' || row.value === 0)) {
       // Consider patient_detection=0 as out_of_bed ONLY if no other conflicting 'in bed' state exists
       // This logic might need refinement based on exact sensor behavior
       const conflicts = relevantRows.some(r =>
          r !== row && // Not the same row
          (r.type === 'patient_detection' && (r.value === '1' || r.value === '2' || r.value === '4')) && // Is an 'in bed' type
          // Check for overlap
          (isBefore(r.start, segmentEnd) && isAfter(r.end, segmentStart))
       );
       if (!conflicts) {
           type = 'out_of_bed';
       }
    } // Add other type mappings if necessary

    // 3. Add the Actual Activity Segment
    const duration = differenceInMinutes(segmentEnd, segmentStart);
    if (duration > 0.1) { // Avoid tiny segments
      segments.push({ type, duration, start: segmentStart, end: segmentEnd, originalRow: row });
    }

    // Update position only if this segment ends later than the current marker
    currentPositionTime = dateMax([currentPositionTime, segmentEnd]);
  });

  // Add final gap if needed, up to timelineEnd
  if (isAfter(timelineEnd, currentPositionTime)) {
    const finalGapDuration = differenceInMinutes(timelineEnd, currentPositionTime);
    if (finalGapDuration > 0.1) {
      segments.push({ type: 'gap', duration: finalGapDuration, start: currentPositionTime, end: timelineEnd });
    }
  }

  // --- Rendering ---
  const getColor = (type) => {
    switch (type) {
      case 'high': return '#ef4444'; // Red-500
      case 'light': return '#f59e0b'; // Amber-500
      case 'resting': return '#6b7280'; // Gray-500
      case 'out_of_bed': return '#e5e7eb'; // Gray-200
      case 'gap': return '#f3f4f6'; // Gray-100 (background color)
      default: return '#d1d5db'; // Gray-300
    }
  };

  const getLabel = (type) => {
    switch (type) {
      case 'high': return 'High Restlessness';
      case 'light': return 'Light Restlessness';
      case 'resting': return 'Resting';
      case 'out_of_bed': return 'Out of Bed';
      case 'gap': return 'No Data / Gap';
      default: return 'Unknown';
    }
  };

  // Hourly Markers
  const hourMarkers = Array.from({ length: totalTimelineHours }).map((_, i) => {
    const hourDate = new Date(timelineStart);
    hourDate.setHours(hourDate.getHours() + i + 1); // +1 because we mark the END of the hour
    const percentage = ((i + 1) / totalTimelineHours) * 100;
    return { percentage, label: format(hourDate, 'HH:mm') };
  });


  return (
    <div style={{ marginTop: 24, marginBottom: 16 }}>
      <h4 style={{ textAlign: 'center', color: '#334155', marginBottom: 12, fontWeight: 600 }}>
        Activity Timeline ({format(timelineStart, 'MMM d, HH:mm')} - {format(timelineEnd, 'HH:mm')})
      </h4>

      {/* Timeline Container with Hourly Markers */}
      <div style={{ position: 'relative', height: 28, background: getColor('gap'), borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb', marginBottom: 20 }}>
        {/* Segments */}
        <div style={{ display: 'flex', height: '100%', position: 'absolute', width: '100%' }}>
          {segments.map((segment, index) => (
            <div
              key={index}
              style={{
                width: `${Math.max(0, (segment.duration / totalTimelineMinutes) * 100)}%`,
                backgroundColor: getColor(segment.type),
                // borderRight: index < segments.length - 1 ? '1px solid rgba(255,255,255,0.3)' : 'none', // Remove divider for cleaner look
                boxSizing: 'border-box',
              }}
              title={`${getLabel(segment.type)} (${format(segment.start, 'HH:mm')} - ${format(segment.end, 'HH:mm')}, ${segment.duration.toFixed(0)} min)`}
            />
          ))}
        </div>

        {/* Hourly Markers */}
        {hourMarkers.map((marker, index) => (
          <div key={index} style={{
            position: 'absolute',
            left: `${marker.percentage}%`,
            top: 0,
            bottom: 0,
            width: '1px',
            backgroundColor: 'rgba(0, 0, 0, 0.1)', // Faint black line
          }}>
             {/* Position label centered under the marker line */}
             <span style={{
                 position: 'absolute',
                 top: 'calc(100% + 2px)', // Position below the bar with a small gap
                 left: '0%', // Align start of text with the marker line
                 transform: 'translateX(-50%)', // Shift text left by half its width to center it
                 fontSize: '10px', // Slightly larger font
                 color: '#475569', // Slightly darker color
                 whiteSpace: 'nowrap'
             }}>
                 {marker.label}
             </span>
          </div>
        ))}

      </div>


      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginTop: '10px', fontSize: '11px', color: '#4b5563', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getColor('high'), marginRight: 4 }}></span>High Restl.</span>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getColor('light'), marginRight: 4 }}></span>Light Restl.</span>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getColor('resting'), marginRight: 4 }}></span>Resting</span>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getColor('out_of_bed'), marginRight: 4 }}></span>Out of Bed</span>
         <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getColor('gap'), border: '1px solid #d1d5db', marginRight: 4 }}></span>Gap/No Data</span>
      </div>
    </div>
  );
};

// ────────── Day Detail Modal ──────────
const DayDetailModal = ({ isOpen, onClose, dayData, avgData, dayKey, rawRowsForDay /* removed highRestlessPercentThreshold */ }) => {
  if (!isOpen || !dayData || !avgData) return null;

  const dayDate = parseISO(dayKey);
  const dayHours = (dayData.inBedMinutes / 60).toFixed(1);
  const dayRepos = dayData.repositions;
  const dayExits = dayData.exits; // Use new exit data
  const restlessPercent = dayData.restlessPercent;
  const longestSleep = dayData.longestContinuousSleepHours;

  // REMOVED Activity Pie Chart Data (was based on restlessMinutes, less relevant now?)
  // REMOVED Bar Chart Data (comparison vs avg might be less useful without risk scores)

  const modalKpiStyle = { marginBottom: '12px', fontSize: '14px', color: '#334155' };

  return (
    <div style={modalBackdropStyle} onClick={onClose}>
      <motion.div
        style={modalContentStyle}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 20, color: '#1e1b4b', textAlign: 'center' }}>
          Details for {format(dayDate, 'MMMM d, yyyy')}
        </h3>

        {/* Display Key Metrics */}
         <div style={{ marginBottom: '24px', borderBottom: '1px solid #e2e8f0', paddingBottom: '16px'}}>
             <p style={modalKpiStyle}><strong>Time in Bed:</strong> {dayHours} hours</p>
             <p style={modalKpiStyle}><strong>Restless:</strong> {restlessPercent}%</p>
             <p style={modalKpiStyle}><strong>Longest Continuous Sleep:</strong> {longestSleep} hours</p>
             <p style={modalKpiStyle}><strong>Reposition Events:</strong> {dayRepos}</p>
             <p style={modalKpiStyle}><strong>Bed Exits:</strong> {dayExits}</p> {/* Use new exit count */}
             {/* REMOVED Fall Risk Score */}
         </div>

        {/* Activity Timeline */}
        <ActivityTimeline
           rows={rawRowsForDay}
           dayKey={dayKey}
        />

        <button onClick={onClose} style={closeButtonStyle}>Close</button>
      </motion.div>
    </div>
  );
};

// Styles for Modal
const modalBackdropStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modalContentStyle = {
  background: '#fff',
  padding: '30px',
  borderRadius: '12px',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.1)',
  maxWidth: '600px',
  width: '90%',
  position: 'relative',
};

const closeButtonStyle = {
  position: 'absolute',
  top: '15px',
  right: '15px',
  background: 'none',
  border: 'none',
  fontSize: '18px',
  cursor: 'pointer',
  color: '#94a3b8',
};
closeButtonStyle.padding = '0.5rem 1rem';
closeButtonStyle.borderRadius = '8px';
closeButtonStyle.fontWeight = '600';
closeButtonStyle.transition = 'all .2s';
closeButtonStyle.background = '#e2e8f0';
closeButtonStyle.color = '#334155';
closeButtonStyle.position = 'static';
closeButtonStyle.display = 'block';
closeButtonStyle.margin = '24px auto 0';

// ... (Loading overlay style added) ...
const loadingOverlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(255, 255, 255, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.2em',
    color: '#1e1b4b',
    zIndex: 2000, // Ensure it's on top
};
