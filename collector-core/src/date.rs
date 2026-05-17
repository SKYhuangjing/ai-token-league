use chrono::{Local, NaiveDate, TimeZone, Timelike};

pub fn app_time_zone() -> String {
    if let Ok(tz) = std::env::var("APP_TIME_ZONE") {
        if !tz.is_empty() {
            return tz;
        }
    }
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.is_empty() {
            return tz;
        }
    }
    // Chrono Local uses system timezone
    let now = Local::now();
    format!("{}", now.offset())
}

/// Returns today's date as YYYY-MM-DD in local timezone.
pub fn local_day() -> String {
    let now = Local::now();
    format!("{}", now.format("%Y-%m-%d"))
}

/// Returns the date portion of a timestamp (milliseconds since epoch) as YYYY-MM-DD in local timezone.
pub fn local_day_from_timestamp_ms(ms: i64) -> String {
    let secs = ms / 1000;
    let nsecs = ((ms % 1000).unsigned_abs() as u32) * 1_000_000;
    let dt = Local
        .timestamp_opt(secs, nsecs)
        .single()
        .unwrap_or_else(Local::now);
    format!("{}", dt.format("%Y-%m-%d"))
}

/// Returns the hour (0-23) of a timestamp in local timezone.
pub fn local_hour_from_timestamp_ms(ms: i64) -> u32 {
    let secs = ms / 1000;
    let nsecs = ((ms % 1000).unsigned_abs() as u32) * 1_000_000;
    let dt = Local
        .timestamp_opt(secs, nsecs)
        .single()
        .unwrap_or_else(Local::now);
    dt.time().hour()
}

/// Parses YYYY-MM-DD to a UTC NaiveDate at midnight.
pub fn day_to_utc_date(day: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
}

/// Formats a NaiveDate as YYYY-MM-DD.
pub fn utc_date_to_day(date: NaiveDate) -> String {
    format!("{}", date.format("%Y-%m-%d"))
}

/// Adds `count` days to a YYYY-MM-DD string.
pub fn add_days(day: &str, count: i64) -> Option<String> {
    let date = day_to_utc_date(day)?;
    let new_date = date + chrono::Duration::days(count);
    Some(utc_date_to_day(new_date))
}

/// Returns all YYYY-MM-DD strings from start (inclusive) to end (inclusive).
pub fn days_between(start_day: &str, end_day: &str) -> Vec<String> {
    let start = match day_to_utc_date(start_day) {
        Some(d) => d,
        None => return vec![],
    };
    let end = match day_to_utc_date(end_day) {
        Some(d) => d,
        None => return vec![],
    };
    if start > end {
        return vec![];
    }
    let mut days = Vec::new();
    let mut current = start;
    while current <= end {
        days.push(utc_date_to_day(current));
        current += chrono::Duration::days(1);
    }
    days
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    #[test]
    fn test_local_day_format() {
        let day = local_day();
        assert!(day.len() == 10);
        assert!(day.chars().nth(4) == Some('-'));
        assert!(day.chars().nth(7) == Some('-'));
    }

    #[test]
    fn test_day_to_utc_date() {
        let date = day_to_utc_date("2024-01-15").unwrap();
        assert_eq!(date.year(), 2024);
        assert_eq!(date.month(), 1);
        assert_eq!(date.day(), 15);
    }

    #[test]
    fn test_day_to_utc_date_invalid() {
        assert!(day_to_utc_date("not-a-date").is_none());
    }

    #[test]
    fn test_add_days() {
        assert_eq!(add_days("2024-01-15", 1), Some("2024-01-16".to_string()));
        assert_eq!(add_days("2024-01-01", -1), Some("2023-12-31".to_string()));
    }

    #[test]
    fn test_days_between() {
        let days = days_between("2024-01-01", "2024-01-03");
        assert_eq!(days, vec!["2024-01-01", "2024-01-02", "2024-01-03"]);
    }

    #[test]
    fn test_days_between_reversed() {
        let days = days_between("2024-01-03", "2024-01-01");
        assert!(days.is_empty());
    }

    #[test]
    fn test_utc_date_to_day() {
        let date = NaiveDate::from_ymd_opt(2024, 3, 15).unwrap();
        assert_eq!(utc_date_to_day(date), "2024-03-15");
    }
}
